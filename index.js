/*

  ToDo
 
  Test:

  * Multiple puts without full rebuild, both changes and additions, then query
  * Rebuild after above test

  Parse JSON query results and stream leveldb results.
  Keep track of streamed keys and ensure no dupes.

  How do we find latest main database when initializing? If we look at highest number or most recently changed then it could be a partially written database (if app crashed mid-write). Are any of the several files not actually written until the database has finished building?

  When initialized the name of the current update dbs should be found by looking for the db called 'update*.nin' that was most recently modified or with the largest file size (looking at file size would protect against opening a partially written db in case of a crash, but won't work for main db). 

  If a put is a change, how do we ensure that only the new version is reported?
  Can we just search the databases in the right order and ignore all other than the first hit for that key?
  That's what we're doing now. Test that it works.

  What do we do about rebuild_counter overflows? Look at NOTES

*/

var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');
var util = require('util');
var path = require('path');
var xtend = require('xtend');
var bytewise = require('bytewise');
var tmp = require('tmp');
var levelup = require('levelup');
var through = require('through2');
var from = require('from2');
var async = require('async');
var changes = require('level-changes');
var EventEmitter = require('events').EventEmitter;

// hash an operation
function hash(type, key, value) {

  // yes sha256 is slow but really not much slower than any other hash in node
  // https://github.com/hex7c0/nodejs-hash-performance
  var h = crypto.createHash('sha256');
  
  h.update(type);
  h.update(key);
  if(value) {
    if(typeof value === 'object' && !Buffer.isBuffer(value)) {
      h.update(JSON.stringify(value));
    } else {
      h.update(value);
    }
  }

  return h.digest('base64');
}

// resolve a path like ['foo', 'bar', 'baz']
// to return the value of obj.foo.bar.baz
// or undefined if that path does not exist
function resolvePropPath(obj, path) {

  if(path.length > 1) {
    if(!obj[path[0]]) return undefined;

    return resolvePropPath(obj[path[0]], path.slice(1, path.length));
  }

  if(path.length === 1) {
    return obj[path[0]];
  }

  return undefined;
}

function BlastLevel(db, opts) {
  if(!(this instanceof BlastLevel)) return new BlastLevel(db, opts);

  opts = xtend({    
    mode: 'blastdb', // 'blastdb' or 'direct' (slower) or 'streaming' (very slow)
    seqProp: 'sequence', // property of db values that contain the DNA/AA sequence
    path: undefined, // path to use for storing BLAST database (blastdb mode only)
    listen: true, // listen for changes on db and update db automatically
    rebuild: false, // rebuild the BLAST index now
    rebuildOnChange: false, // rebuild the main BLAST db whenever the db is changed
    binPath: undefined, // path where BLAST+ binaries are located if not in PATH
    debug: false // turn debug output on or off
  }, opts);
  this.opts = opts;

  this._queryCount = {}; // number of active queries for each db, indexed by name
  this._toDelete = [];


  if(opts.mode === 'blastdb' && !opts.path) {
    throw new Error("opts.path must be specified in 'blastdb' mode");
  }

  if(!db) {
    throw new Error("First argument must be a level instance");
  }

/*
  this._dbOpts = {
    keyEncoding: 'utf8', 
    valueEncoding: 'json'
  };
*/
  this.db = db; // leveldb instance

  this._ready = false; // is blast-level fully initialized
  this._changed = false; // did db change since last processing? only used when rebuildOnChange:true
  this._changeBuffer = []; // buffer changes here until this._ready is true
  this._processingBuffer = false; // is the buffer currently being processed?

  this._ignoreList = {};
  this._ignoreCount = 0;

  // BLAST databases
  this._dbs = {
    rebuildCount: 0, // number of rebuilds completed
    main: {
      lastRebuild: 0, // number of last completed rebuild
      exists: false
    },
    update: {
      lastRebuild: 0,
      exists: false
    }
  };

  // ----------- init


  this._init = function() {
    var self = this;

    function cb(err) {
      if(err) return self.emit('error', err);
      self._ready = true;
      self.emit('ready');
      console.log("ready!");
      self._processBuffer();
    }
  
    if(this.opts.listen) {
      this.c = changes(this.db);
      this.c.on('data', this._onChange.bind(this));
    }    

    this._checkDB('main', this.opts.rebuild, function(err) {
      if(err) return cb(err);

      // no need to check update db if main doesn't exist
      if(!self._dbs.main.exists) return cb();

      self._checkDB('update', false, cb);
    });
  };

  this._buffer = function(change) {
    console.log("+++++++ buffering:", change);
    this._changeBuffer.push(change);
  };

  this._processBuffer = function() {
    var self = this;

    // if we're already processing then we don't want to trigger again
    if(this._processingBuffer) return;

    // if we're doing a complete rebuild on every change
    // then we're not actually using the buffer, just the this._changed flag
    if(this.opts.rebuildOnChange) {
      if(!this._changed) return;
      this._processingBuffer = true;
      this._changed = false;
      this.rebuild(function(err) {
        self._processingBuffer = false;

        // if there was a change during the rebuild, process again
        if(self._changed) self._processBuffer();
      });
      return;
    }

    console.log("####### processing change buffer of length:", this._changeBuffer.length);

    this._processingBuffer = true;

    var changes;
    async.whilst(
      function() {
        return !!(self._changeBuffer.length)
      }, function(cb) {
        changes = self._changeBuffer;
        self._changeBuffer = [];
        
        self._processPuts(changes, cb);
      }, function(err) {
        if(err) console.error("Processing buffer failed:", err);
        self._processingBuffer = false;
      });

  };

  this._onChange = function(change) {
    if(this._shouldIgnore(change)) return;

    if(this.opts.rebuildOnChange) {
      this._changed = true;
    } else {
      if(change.type === 'put') {
        this._buffer(change);
      }
    }

    if(!this._ready) return;
    this._processBuffer();
  };

  // only called if opts.rebuildOnChange is false
  this._processPuts = function(changes, cb) {
    cb = cb || function(){};
    if(!(changes instanceof Array)) changes = [changes];

    if(!this._dbs.main.exists) {
      this._rebuild('main', cb);
      return;
    }

    this._rebuild('update', changes, cb);
  };

  // ----------- methods below

  // Ignore the next time this operation occurs.
  // Used by this._put, this._del and this._batch
  this._ignore = function(type, key, value) {
    var h = hash(type, key, value);
    if(this._ignoreList[h]) {
      this._ignoreList[h]++;
    } else {
      this._ignoreList[h] = 1;
    }
    this._ignoreCount++;
  };

  // check if we should ignore this operation
  // and remove from ignore list
  this._shouldIgnore = function(op) {

    if(this._ignoreCount <= 0) return;
    var h = hash(op.type, op.key, op.value);

    if(this._ignoreList[h]) {
      if(this._ignoreList[h] === 1) {
        delete this._ignoreList[h];
      } else {
        this._ignoreList[h]--;
      }
      this._ignoreCount--;
      return true;
    }
    return false;
  };
  
  this._resolvePropPath = function(value, pathOrFunc) {
    if(typeof pathOrFunc === 'function') return pathOrFunc(value);

    if(typeof pathOrFunc === 'string') {
      return resolvePropPath(value, pathOrFunc.split('.'));
    }
    
    if(pathOrFunc instanceof Array) {
      return resolvePropPath(value, pathOrFunc);
    }

    throw new Error("Value must be string, array or function");
  };
  

  this._onPut = function(key, value, cb) {

  };
  
  this._onDel = function(key, cb) {
    cb = cb || function(){};

    if(this.opts.rebuildOnChange) {
      this._rebuild('main', cb);
    }
  };


  this._doesBlastDBExist = function(dbName, cb) {
    var self = this;

    var dbPath = path.join(self.opts.path, dbName+'.nin');
    fs.stat(dbPath, function(err, stats) {
      if(err) {
        if(err.code == 'ENOENT') {
          return cb(null, false);
        } else {
          return cb(err);
        }
      }
      if(!stats.isFile()) {
        return cb(new Error("Blast DB file isn't a file: " + dbPath));
      }
      cb(null, true);
    });
  };

  this._checkDB = function(which, create, cb) {
    var self = this;

    var dbName = this._dbName(which, true);

    console.log("@@@ checking if db exists:", dbName)

    fs.stat(self.opts.path, function(err, stats) {
      if(err) {
        if(err.code === 'ENOENT') {
          console.log("@@@ it didn't even have a parent dir:", dbName);

          fs.mkdir(self.opts.path, function(err) {
            if(err) return cb(err);
            if(!create) return cb()
            console.log("@@@ running _rebuild for:", which);
            self._rebuild(which, cb);
          });
          return;
        } else {
          return cb(err);
        }
      }

      if(!stats.isDirectory()) {
        return cb(new Error("Specified path must be a directory"));
      }

      self._doesBlastDBExist(dbName, function(err, exists) {
        if(err) return cb(err);
        if(exists) {
          console.log("@@@ it exists!", dbName);
          self._dbs[which].exists = true;
          return cb();
        }
        if(!create) return cb()
        console.log("@@@ running _rebuild for:", which);
        self._rebuild(which, cb);
      });
    });
  }

  // rebuild a blast db
  // which is either 'main' or 'update'
  // data is optionally a single {key: ..., value: ...} object
  // to build the database from
  this._rebuild = function(which, data, cb) {

    if(typeof data === 'function') {
      cb = data;
      data = null;
    }
    var self = this;
    cb = cb || function(){};
    
    // give this rebuild the next available build number
    var buildNum = ++(this._dbs.rebuildCount);
    
    // generate a directory-unique db name
    var dbName = this._numberToDBName(which, buildNum);
    console.log("@@@ _rebuild db:", dbName);
    console.log("@@@ _buffer:", this._changeBuffer.length);
    
    // pick the function to actually call to rebuild
    // based on whether we're rebuilding the 'main' or 'update' db
    var f;
    if(which === 'main') {
      f = this._rebuildMainDB.bind(this);
    } else { // 'update'
      f = this._rebuildUpdateDB.bind(this);
    }
    
    f(dbName, data, function(err) {
      if(err) return cb(err);
      
      console.log("@@@ finalizing _rebuild:", dbName)

      // if this build's number is greater than the number of the
      // most recently completed rebuild then we know our rebuild
      // is newer than the previous rebuild so we can safely
      // move the current db reference to point to the db we just built
      // and mark the "previous current" db for deletion
      // There may still be references to the previous current db 
      // e.g. there may be queries in progress on it, so we can't just
      // delete it right away.

      if(!(buildNum > self._dbs[which].lastRebuild)) {
        // another more recent rebuild completed before us so our
        // rebuild is now outdated and we can delete it immediately
        // since no other references to this db will exist
        self._deleteDB(dbName); // callback doesn't have to wait for this
        return cb();
      }
      
      var lastName = self._numberToDBName(which, self._dbs[which].lastRebuild);
      
      if(self._dbs[which].exists && self._dbs[which].lastRebuild) {
        self._attemptDelete(lastName)
      };
      self._dbs[which].lastRebuild = buildNum;
      
      // if this is a rebuild on the main db, also delete the previous update if one exists and is older than this main db rebuild
      if(which === 'main') {
        console.log("--------------", self._dbs.update.exists, buildNum, self._dbs.update.lastRebuild);
        if(self._dbs.update.exists && (buildNum > self._db.update.lastRebuild)) {
          var lastUpdateName = self._numberToDBName('update', self._dbs.update.lastRebuild);
          self._attemptDelete(lastUpdateName);
          self._dbs.update.exists = false;
        } 
      }
      cb();
    });
  };


  // get the sequence data from a leveldb value
  this._seqFromVal = function(val) {
    return val[this.opts.seqProp];
  }
  

  this._debug = function(msg) {
    if(!this.opts.debug) return;
    console.log('[debug]', msg);
  };


  this._changeQueryCount = function(names, num) {
    if(!(names instanceof Array)) {
      names = [names];
    }
    var i;
    for(i=0; i < names.length; i++) {
      if(this._queryCount[names[i]]) {
        this._queryCount[names[i]] += num;
      } else {
        this._queryCount[names[i]] = num;
      }
    }
  };


  // Builds a blast db from all sequences in the leveldb instance
  // or from a specified readable stream
  // callback gives back args:
  //   err
  //   count: number of sequences added to database
  // If count is 0 then no database was created since makeblastdb
  // will not create empty databases
  // Set opts.stream to a stream outputting FASTA sequences 
  // or a stream will be created outputting all sequences in the level db
  this._createBlastDB = function(name, opts, cb) {
    var self = this;

    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    
    var dbPath = path.join(self.opts.path, name);
    console.log("");
    console.log("---------------------------------------------");
    console.log("creating blast db:", dbPath);

    var cmd = path.join(this.opts.binPath, "makeblastdb");
    var args = ["-dbtype", "nucl", "-title", "'blastlevel'", "-out", dbPath];

    // creating blast db from one or more existing blast dbs 
    // (concatenate databases)
    if(opts.fromBlastDBs) {
      console.log("CONCAT");
      var dbPaths = opts.fromBlastDBs.map(function(dbName) {
        return path.join(self.opts.path, dbName);
      });

      args = args.concat(['-in', dbPaths.join(' '), '-input_type', 'blastdb']);

      console.log("running:", cmd, args.join(' '));

      var makedb = spawn(cmd, args);

    } else { // creating from a stream

      console.log("running:", cmd, args.join(' '));

      var seqStream = this._seqStream();
      var makedb = spawn(cmd, args);

      if(opts.stream) { // stream was supplied as opts argument
        opts.stream.pipe(seqStream);

      } else { // no stream specified so make a stream from entire database

        // TODO assuming JSON values (what if it's a string or buffer?)
        this.db.createReadStream({valueEncoding: 'json'}).pipe(seqStream);
      }
      seqStream.pipe(makedb.stdin);
    }

    var stderr = '';

    var addedCount = 0;
    var str, m;

    makedb.stdout.on('data', function(data) {
      str = data.toString();
      self._debug("[makeblastdb] " + str);
      m = str.match(/added (\d+) sequences in/);
      if(!m) return;
      addedCount = parseInt(m[1]);
    });

    makedb.on('close', function() {
      stderr = stderr ? new Error(stderr) : undefined;
      cb(stderr, addedCount)
    });

    makedb.stderr.on('data', function(data) {
      stderr += data.toString();
    });    
    
    makedb.stderr.on('close', function() {
      // Ignore "no sequences added" errors
      m = stderr.match(/No sequences added/i);
      if(m) stderr = '';
    });
  };

  // Take a leveldb entry object (with .key and .value) 
  // and turn it into fasta-formatted output that can be
  // referenced back to the leveldb entry
  this._fastaFormat = function(data) {
    var line = "> id:" + data.key + "\n" + this._seqFromVal(data.value) + "\n";
    return line;
  };

  // create stream of sequences
  this._seqStream = function() {
    var self = this;
    
    // TODO assuming object mode stream (what if it's a string or buffer?)
    var seqStream = through.obj(function(data, enc, cb) {
      if(data.value && self._seqFromVal(data.value)) {
        console.log("|||||||||||| Added:", self._seqFromVal(data.value));
        this.push(self._fastaFormat(data));
      }
      cb();
    });
    
    return seqStream;
  };

  // do any blast databases currently exist?
  this._hasBlastDBs = function() {
    if(this._dbs.main.exists || this._dbs.update.exists) {
      return true;
    }
    return false;
  };

  // name of current db
  this._dbName = function(which, force) {
    if(!this._dbs[which].exists && !force) return null;
    return this._numberToDBName(which, this._dbs[which].lastRebuild);
  };

  this._numberToDBName = function(which, number) {
    return which + '-' + number;
  };

  // delete all dbs that are queued for deletion and
  // which no longer have any running queries
  this._processDeletions = function(cb) {
    var self = this;
    
    if(this._toDelete.length <= 0) {
      if(cb) process.nextTick(cb);
      return;
    }
    cb = cb || function(){};

    async.each(this._toDelete, function(toDelete, cb) {
      // Don't delete dbs that still have active queries.
      // This function is also called after
      // each query ends so all will be cleaned up.
      if(self._queryCount[toDelete]) return cb();

      var i = self._toDelete.indexOf(toDelete);
      self._toDelete.splice(i, 1);

      self._deleteDB(toDelete, cb);
    }, cb);
  };

  this._deleteDB = function(name, cb) {
    cb = cb || function(){};
    var exts = [
      'nhr',
      'nin',
      'nnd',
      'nni',
      'nsd',
      'nsi',
      'nsq'
    ];
    var self = this;
    
    async.each(exts, function(ext, cb) {
      fs.unlink(path.join(self.opts.path, name+'.'+ext), cb);
    }, function(err) {
      if(err) return cb(err);
    });
  };



  // this function ignores the data argument
  this._rebuildMainDB = function(dbName, data, cb) {
    var self = this;
    
    this._createBlastDB(dbName, function(err, count) {
      if(err) return cb(err);

      console.log("$$$$$$$$$$$", dbName, "created with", count);

      self._dbs.main.exists = (count == 0) ? false : true;
      
      cb();
    });
  };

  // create a stream that emits the single object: data
  // stripping all but .key and .value properties
  this._singleObjectStream = function(data) {
    var done = false;
    // create a stream that emits a single object and closes
    return from.obj(function(size, next) {
      if(done) return next(null, null);
      done = true;    
      next(null, {key: data.key, value: data.value});
    });
  };

  // create a stream that emits the objects in the array `items`
  // stripping all but .key and .value properties of each object
  this._arrayToStream = function(items) {
    var item;
    return from.obj(function(size, next) {
      if(!items.length) return next(null, null);
      item = items[0];
      items = items.slice(1);

      this.push({key: item.key, data: item.value})

      next();
    });
  };

  this._rebuildUpdateDB = function(dbName, data, cb) {
    var self = this;
   
    // build db from single sequence
    // data should have data.key and data.value
    
    var s = this._arrayToStream(data);

    var newSeqsDBName = dbName;
      
    if(this._dbs.update.exists) {
      console.log(" !!!!!!!! udate db exists");
      newSeqsDBName += '_tmp';
    }

    this._createBlastDB(newSeqsDBName, {stream: s}, function(err, count) {
      if(err) return cb(err);

      console.log("$$$$$$$$$$$", dbName, "created with", count);

      // if there wasn't an existing update database, we're done here
      if(!self._dbs.update.exists) {
        console.log(" !!!!!!!! update db became real after:", dbName);
        self._dbs.update.exists = true;
        cb();
        return;
      }

      // there was an existing update database
      // so create a new update database by concatenating the old 
      // update database with the new single sequence database
      self._createBlastDB(dbName, {
        fromBlastDBs: [
          self._dbName('update'),
          newSeqsDBName
        ]
      }, function(err, count) {
        if(err) return cb(err);

        console.log("$$$$$$$$$$$", dbName, "created with", count);

        cb();
      });
    });
  };

  // get db name(s) to use for queries
  this._queryDBs = function() {
    var maindb = this._dbName('main');
    var updatedb = this._dbName('update');
    var dbs = [];
    if(maindb) dbs.push(maindb);
    if(updatedb) dbs.push(updatedb);
    return dbs;
  };
  

  this._attemptDelete = function(dbName) {
    this._toDelete.push(dbName);
    this._processDeletions();
  };

  // TODO auto-detect if amino acid or nucleotides
  this.query = function(seq, opts, cb) {
    var self = this;
    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if(!self._hasBlastDBs()) {
      return cb(new Error("No blast index. Make sure your database isn't empty, then call .rebuild to build the blast index."));
    }

    opts = xtend({
      type: undefined, // or 'blastn' or 'blastp'. auto-detects if undefined
    }, opts || {});

    if(!opts.type) {
      if(seq.match(/[^ACGT\s]/i)) {
        opts.type = 'blastp';
      } else {
        opts.type = 'blastn';
      }
    }

    var qdbs =  this._queryDBs();
    this._changeQueryCount(qdbs, 1);

    var dbName = qdbs.join(' ');
    var cmd, args;

    if(opts.type === 'blastn') {
      cmd = path.join(this.opts.binPath, "blastn");
      args = ["-task", "blastn-short", "-outfmt", "15", "-db", dbName];
    } else {
      // TODO support blastp
      throw new Error("blastp not implemented");
    }

    console.log("RUNNING:", cmd, args.join(' '));

    var blast = spawn(cmd, args, {
      cwd: this.opts.path
    });

    // TODO what to do about blast.stderr?
    var output = '';
    var stderr = '';

    blast.stdout.on('data', function(data) {
      data = data.toString();
      self._debug("["+opts.type+" stdout] " + data);
      
      output += data;
    });

    blast.stderr.on('data', function(data) {
        stderr += data.toString();
    });

    blast.stdin.on('error', function(err) {
        // these error messages are rarely useful
        // and are accompanied by more useful .stderr messages
        // so just make sure they're handled and throw away the message
    });

    blast.on('close', function(code) {
      if(code) {
        stderr = stderr || "blast command exited with non-zero exit code";
      }

      self._changeQueryCount(qdbs, -1);
      self._processDeletions(); // callback doesn't have to wait for this
      
      if(stderr) return cb(new Error(stderr));

      try {
        output = JSON.parse(output);
      } catch(e) {
        return cb(new Error("Error parsing BLAST JSON output"));
      }
      cb(null, output);
    });

    blast.stdin.end(seq, 'utf8');
  };

  this.rebuild = function(cb) {
    this._rebuild('main', cb);
  };


  this._init();
};

util.inherits(BlastLevel, EventEmitter);

module.exports = BlastLevel;
