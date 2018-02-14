
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var crypto = require('crypto');
var fs = require('fs-extra');
var util = require('util');
var path = require('path');
var xtend = require('xtend');
var through = require('through2');
var from = require('from2');
var async = require('async');
var changes = require('level-changes');
var rimraf = require('rimraf');
var EventEmitter = require('events').EventEmitter;
var PassThrough = require('readable-stream').PassThrough;
var isStream = require('isstream');
var glob = require('glob');
var sse = require('streaming-sequence-extractor');


function dbInfo(dbDir, dbName, cb) {

  if(!dbDir || !dbName) return process.nextTick(cb);

  var o = {
    name: dbName,
    path: path.resolve(path.join(dbDir, dbName) + '.*'),
    size: 0
  }

  glob(o.path, function(err, files) {
    if(err) return cb(err);

    async.each(files, function(file, cb) {
      fs.stat(file, function(err, stats) {
        if(err) return cb(err);

        o.size += stats.size;

        cb();
      });
    }, function(err) {
      if(err) return cb(err);

      cb(null, o);
    });
  });
}

function checkCommand(cmd, cb) {
  var minVersion = '2.4.0';
  minVersion = minVersion.split('.');

  cmd += " -version";

  function versionError(version) {
    return new Error("Installed NCBI BLAST+ version is too low: I need minimum version " + minVersion.join('.') + " and you have version " + version.join('.'));
  }


  exec(cmd, function(err, stdout, stderr) {
    if(err) throw err;
    
    var m = stdout.match(/blast\s+(\d+\.\d+\.\d)+/i);
    if(!m) return cb(new Error("Did not get version from: " + cmd + "\nInstead got: " + stdout));
    
    var version = m[1].split('.');
    var i;
    for(i=0; i < version.length; i++) {
      if(version[i] > minVersion[i]) return cb();
      if(version[i] < minVersion[i]) return cb(versionError(version));
    }

    cb();
  });
}

function checkCommands(binPath, cb) {
  if(typeof binPath === 'function') {
      cb = binPath;
      binPath = undefined;
  }

  if(!cb) cb = function(err) {
    if(err) return console.error(err);
    console.log("Success! You have all of the necessary NCBI BLAST+ tools installed and their versions are compatible with blast-level.");
  };

  var cmds = ['makeblastdb', 'blastn', 'blastp', 'blastx', 'tblastx', 'tblastn'];

  cmds = cmds.map(function(cmd) {
    return path.join(binPath || '', cmd);
  });

  async.eachSeries(cmds, checkCommand, cb);
};

// hash an operation
function hashOp(type, key, value) {

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

// hash one or more arguments
function hash() {
  var h = crypto.createHash('sha256');
  var i;
  for(i=0; i < arguments.length; i++) {
    h.update(arguments[i]);
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
    mode: 'blastdb', // 'blastdb' or 'direct' (slower)
    type: 'nt', // 'nt' for nucleotide database. 'aa' for amino acid database
    seqProp: undefined, // property of leveldb value that contains the DNA/AA sequence or file path
    changeProp: undefined, // property of leveldb value that contains a value that will have changed if the sequence was changed, e.g. a timestamp for when the leveldb value was last updated or a hash of the sequence
    filterChanged: true, // filter seqs that have changed since last rebuild. only relevant in 'blastdb' mode when buildOnChange is false
    seqFormatted: false, // false if plaintext, true if FASTA, GenBank, SBOL, etc. 
    seqIsFile: false, // is seqProp a path to a file or array of files (or a function that returns a path to a file or array of files)? if false then seqProp should be a string or array of strings or a function returning either of those.
    seqFileBasePath: '.', // if seqIsFile, this is the base path
    seqFileEncoding: 'utf8',
    path: undefined, // path to use for storing BLAST database (blastdb mode only)
    listen: true, // listen for changes on level db and update BLAST db automatically
    rebuild: false, // rebuild the BLAST index now
    rebuildOnChange: false, // rebuild the main BLAST db whenever the db is changed
    binPath: undefined, // path where BLAST+ binaries are located if not in PATH
    debug: false // turn debug output on or off
  }, opts);
  this.opts = opts;
  if(!this.opts.binPath) this.opts.binPath = '';

  this._queryCount = {}; // number of active queries for each db, indexed by name
  this._toDelete = [];

  this.opts.type = this.opts.type.toLowerCase();
  if(['nt', 'aa'].indexOf(this.opts.type) < 0) {
    throw new Error("opts.type must be either 'nt' or 'aa'");
  }

  // there will never be changed sequences nor dupes
  // if we're rebuilding on every change nor if we're not using 'blastdb' mode
  if(opts.rebuildOnChange || opts.mode !== 'blastdb') {
    this.opts.filterChanged = false;
  }
  
  if(!opts.seqProp) {
    throw new Error("opts.seqProp must be specified");
  }

  if(opts.mode === 'blastdb') {
    if(!opts.path) {
      throw new Error("opts.path must be specified in 'blastdb' mode");
    }

    if(!opts.changeProp && !opts.rebuildOnChange) {
      throw new Error("opts.changeProp must be specified in 'blastdb' mode unless opts.rebuildOnChange is true");
    }
  }

  if(!db) {
    throw new Error("First argument must be a level instance");
  }

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
//      console.log("ready!");
      self._processBuffer();
    }
  
    if(this.opts.listen) {
      this.c = changes(this.db);
      this.c.on('data', this._onChange.bind(this));
    }    

    if(this.opts.rebuild) {
      fs.emptyDir(this.opts.path, function(err) {
        if(err) return cb(err);

        self.rebuild(cb);
      });     
      return;
    }

    // check if blast db parent dir exists
    this._checkDBParentDir(function(err) {

      // check if a main db exists. if not and if opts.rebuild then create it
      self._openDB('main', self.opts.rebuild, function(err, existed) {
        if(err) return cb(err);

        // if the main db didn't already exist 
        // (meaning doesn't exist now or it does but had to be rebuilt just now)
        // then there's no reason to even check if the update db exists
        if(!existed) return cb();
        
        self._openDB('update', false, cb);
      });
    });
  };

  this._buffer = function(change) {
//    console.log("+++++++ buffering:", change);
    this._changeBuffer.push(change);
  };

  this._processBuffer = function() {
    var self = this;

    // if we're already processing then we don't want to trigger again
    // TODO what if we have a callback?
    if(this._processingBuffer) return;

    // if we're doing a complete rebuild on every change
    // then we're not actually using the buffer, just the this._changed flag
    if(this.opts.rebuildOnChange) {
      if(!this._changed) return;
      this._processingBuffer = true;
      this._changed = false;

      var changes = self._changeBuffer;
      self._changeBuffer = [];

      this.rebuild(function(err) {
        self._processingBuffer = false;
        
        // Run callbacks for all changes (regardless of type)
        // if they are present.
        var i;
        for(i=0; i < changes.length; i++) {
          if(changes[i].cb) changes[i].cb(err);
        }
        
        // if there was a change during the rebuild, process again
        if(self._changed) self._processBuffer();
      });
      return;
    }

//    console.log("####### processing change buffer of length:", this._changeBuffer.length);

    this._processingBuffer = true;

    var changes;
    async.whilst(
      function() {
        return !!(self._changeBuffer.length)
      }, function(cb) {
        changes = self._changeBuffer;
        self._changeBuffer = [];
        
        self._processPuts(changes, function(err) {

          // Run callbacks for all changes (regardless of type)
          // if they are present.
          var i;
          for(i=0; i < changes.length; i++) {
            if(changes[i].cb) changes[i].cb(err);
          }

          cb(err);
        });
      }, function(err) {
        if(err) console.error("Processing buffer failed:", err);
        self._processingBuffer = false;
      }
    );
  };

  this._onChange = function(change, doNotProcess) {
    if(this._shouldIgnore(change)) return;

    if(this.opts.rebuildOnChange) {
      this._changed = true;
    } else {
      if(change.type === 'put') {
        this._buffer(change);
      }
    }

    if(doNotProcess) return;

    // Note that we don't need to do anything for deletions
    // since blast results with missing leveldb keys are
    // simply discarded during query

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
    var h = hashOp(type, key, value);
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
    var h = hashOp(op.type, op.key, op.value);

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

  this._buildNumberFromDBName = function(dbName) {
    return parseInt(dbName.replace(/[^\d]+/g, ''));
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

  // Check if there is an existing BLAST db
  // and store the state in this._dbs if so.
  // If it does not exist and rebuild is true then rebuil it.
  this._openDB = function(which, rebuild, cb) {
    var self = this;

    self._loadBlastDBName(which, function(err, dbName) {
      if(err) return cb(err);    

//      console.log('9999999999999999999================================', dbName);

      if(dbName) {
        self._dbs[which].exists = true;
        self._dbs[which].lastRebuild = self._buildNumberFromDBName(dbName);
        if(self._dbs.rebuildCount < self._dbs[which].lastRebuild) {
          self._dbs.rebuildCount = self._dbs[which].lastRebuild;
        }
        return cb(null, true);
      }

      if(!rebuild) return cb(null, false);

      self._rebuild(which, cb);
    });
  };

  this._checkDBParentDir = function(cb) {
    var self = this;

//    console.log("@@@ checking if db parent dir exists")

    fs.stat(self.opts.path, function(err, stats) {
      if(err) {
        if(err.code === 'ENOENT') {
//          console.log("@@@ parent dir did not exist");

          fs.mkdir(self.opts.path, function(err) {
            if(err) return cb(err);
            cb();
          });
          return;
        } else {
          return cb(err);
        }
      }

      if(!stats.isDirectory()) {
        return cb(new Error("Specified path must be a directory"));
      }

//      console.log("@@@ parent dir exists");
      cb();
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
//    console.log("@@@ _rebuild db:", dbName);
//    console.log("@@@ _buffer:", this._changeBuffer.length);
    
    // pick the function to actually call to rebuild
    // based on whether we're rebuilding the 'main' or 'update' db
    var f;
    if(which === 'main') {
      f = this._rebuildMainDB.bind(this);
//      console.log("REBUILDING MAIN DB");
    } else { // 'update'
      f = this._rebuildUpdateDB.bind(this);
    }
    
    f(dbName, data, function(err) {
      if(err) return cb(err);
    
      self._saveBlastDBName(which, dbName, function(err) {
        if(err) return cb(err);
        
//        console.log("@@@ finalizing _rebuild:", dbName)
        
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

          if(self._dbs.update.exists && (buildNum > self._dbs.update.lastRebuild)) {
            var lastUpdateName = self._numberToDBName('update', self._dbs.update.lastRebuild);
            self._attemptDelete(lastUpdateName);
            self._dbs.update.exists = false;
          } 
        }
        cb();
      });
    });
  };


  this._pushFile = function(filePath, key, index, change, other, cb) {
    var self = this;
    var s = fs.createReadStream(path.join(this.opts.seqFileBasePath, filePath), {encoding: this.opts.seqFileEncoding});
    s.on('error', cb);

    if(!this.opts.seqFormatted) {
      
      other.push(this._fastaHeader(key, index, change));

      s.on('data', function(data) {
        other.push(data);
      });
      s.on('end', cb);
      
    } else { 
      
      if(!index) {
        index = 0;
      }

      var type = (this.opts.type === 'nt') ? 'na' : 'aa';

      var seqStream = sse(type, {
        convertToExpected: true,
        header: function(count) {
          return self._fastaHeader(key, index + count, change)
        }
      });

      seqStream.on('error', cb);
      seqStream.on('data', function(data) {
        other.push(data);
      });
      seqStream.on('end', function() {
        cb();
      });

      s.pipe(seqStream);
    }
  };

  this._changeFromVal = function(val) {
    var change = this._resolvePropPath(val, this.opts.changeProp);
    if(change instanceof Date) {
      return change.getTime();
    }
    if(typeof change === 'object') {
      return JSON.stringify(change);
    }
    return change;
  }

  // get the sequence data from a leveldb value
  this._seqFromVal = function(val) {
    return this._resolvePropPath(val, this.opts.seqProp);
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
        this._queryCount[names[i]] = (num >= 0) ? num : 0;
      }
//      console.log("Query count for", names[i], "changed to:", this._queryCount[names[i]])
    }
  };


  // check if a sequence changed since it was put in the BLAST db
  this._checkChanged = function(value, oldChange) {
    var change = this._changeFromVal(value);
    if(change !== oldChange) {
      return false;
    }
    return true;
  };

  this._levelRowFromBlastHit = function(hit, cb) {
    if(!hit || !hit.description || !hit.description.length || !hit.description[0].title) {
      return cb();
    }

    var o;
    try {
      o = JSON.parse(hit.description[0].title);
    } catch(e) {
      return cb(e);
    }

    var self = this;

    this.db.get(o.key, function(err, value) {
      if(err) return cb(err);

      // If the sequence changed in leveldb since the this
      // BLAST database was rebuilt, then the change value will be different.
      // We don't want to report such results since they could be false hits.
      // The current BLAST update db should contain the updated version of
      // the sequence and so the BLAST results should still contain the
      // actual hit (if one exists).
      if(self.opts.filterChanged && !self._checkChanged(value, o.change)) return cb();

      o = {
        key: o.key,
        value: value,
        index: o.index
      };

      if(hit.hsps && hit.hsps.length) {
        o.hsps = hit.hsps;
      }

      cb(null, o);
    });

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

    var cmd = path.join(this.opts.binPath, "makeblastdb");
    var args = ["-dbtype", "nucl", "-title", "'blastlevel'", "-out", dbPath];

    // creating blast db from one or more existing blast dbs 
    // (concatenate databases)
    if(opts.fromBlastDBs) {
//      console.log("CONCAT");
      var dbPaths = opts.fromBlastDBs.map(function(dbName) {
        return path.join(self.opts.path, dbName);
      });

      args = args.concat(['-in', dbPaths.join(' '), '-input_type', 'blastdb']);

//      console.log("running:", cmd, args.join(' '));

      var makedb = spawn(cmd, args);

    } else { // creating from a stream

//      console.log("running:", cmd, args.join(' '));

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


  this._fastaHeader = function(key, index, change) {
    var header = {
      key: key,
      change: change
    };
    if(index !== undefined) {
      header.index = index;
    }
    return JSON.stringify(header);
  };
  
  // Take a leveldb entry object (with .key and .value) 
  // and turn it into fasta-formatted output that can be
  // referenced back to the leveldb entry by keeping
  // the id and hash as JSON in the FASTA header
  // TODO make this streaming (or at least the hashing)
  this._fastafy = function(key, seq, index, change) {
    return ">" + this._fastaHeader(key, index, change) + "\n" + seq + "\n\n";
  };


  // create a stream that takes as input leveldb values
  // and outputs a stream of FASTA sequences with
  // the header referencing the original FASTA sequence
  this._seqStream = function() {
    var self = this;
    var seq, filePath, change, i;
    // TODO assuming object mode stream (what if it's a string or buffer?)

    var seqStream = through({
      writableObjectMode: true,
      readableObjectMode: false,
      highWaterMark: 16
    }, function(data, enc, cb) {

      if(!data.value) return cb();

      seq = self._seqFromVal(data.value);
      change = self._changeFromVal(data.value);

//      console.log('---------------------------', seq, change);
      if(!seq || !change) return cb();

      if(!self.opts.seqIsFile) {

        // TODO handle non-file formatted streams
        if(self.opts.seqFormatted) {
          throw new Error("TODO not implemented");
        }

        if(seq instanceof Array) {
          for(i=0; i < i.length; i++) {
            this.push(self._fastafy(data.key, seq[i], i, change));
          }
        } else {
          this.push(self._fastafy(data.key, seq, undefined, change));
        }
        
        cb();
   
      } else { 
        filePath = seq;

        if(filePath instanceof Array) {

          i = 0;
          async.eachSeries(filePath, function(filePath, cb) {
            
            self._pushFile(filePath, data.key, i++, change, this, cb);

          }, cb);

        } else {
          
          self._pushFile(filePath, data.key, undefined, change, this, cb);

        }
      }
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
    
//    console.log("--- processing deletions: ", this._toDelete);
//    console.log("      counts:", this._queryCount);

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
      'nsq',
      'nog'
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

//      console.log("$$$$$$$$$$$", dbName, "created with", count);

      self._dbs.main.exists = (count == 0) ? false : true;
      
      cb();
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
      next(null, {key: item.key, value: item.value})
    });
  };

  this._rebuildUpdateDB = function(dbName, data, cb) {
    var self = this;
   
    // build db from single sequence
    // data should have data.key and data.value
    
    var s = this._arrayToStream(data);

    var newSeqsDBName = dbName;
      
    if(this._dbs.update.exists) {
//      console.log(" !!!!!!!! udate db exists");
      newSeqsDBName += '_tmp';
    }

    this._createBlastDB(newSeqsDBName, {stream: s}, function(err, count) {
      if(err) return cb(err);

//      console.log("$$$$$$$$$$$", dbName, "created with", count);

      // if there wasn't an existing update database, we're done here
      if(!self._dbs.update.exists) {
//        console.log(" !!!!!!!! update db became real after:", dbName);
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
        if(err) return cb(err); // TODO clean up _tmp dir on error

//        console.log("$$$$$$$$$$$", dbName, "created with", count);

        rimraf(path.join(self.opts.path, newSeqsDBName)+'.*', function(err) {
          if(err) return cb(err);

          cb();
        })
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
//    console.log("//// attempting to delete", dbName);
    this._toDelete.push(dbName);
    this._processDeletions();
  };


  // write name of latest blast db name to disk
  // so the correct db can be re-used on next time the lib/app is loaded
  this._saveBlastDBName = function(which, dbName, cb) {
    var self = this;
    if(typeof dbName === 'function') {
      cb = dbName;
      dbName = undefined;
    }
    dbName = dbName || this._dbName(which);

    var stateFilePath = path.join(self.opts.path, which+'.state');

    fs.writeFile(stateFilePath, dbName, {
      encoding: 'utf8'
    }, cb);
  },

  // read latest existing blast database name from disk
  // either 'main' or 'update' db
  this._loadBlastDBName = function(which, cb) {
    var self = this;
    var stateFilePath = path.join(self.opts.path, which+'.state');
    fs.readFile(stateFilePath, {
      encoding: 'utf8'
    }, function(err, dbName) {
      if(err) {
        if(err.code == 'ENOENT') return cb();
        return cb(err);
      }
      dbName = dbName.trim();

      self._doesBlastDBExist(dbName, function(err, doesItExist) {
        if(err) return cb(err);
        if(!doesItExist) return cb();

        cb(null, dbName);
      });
    })
  };
 
  // -------------- public methods below

  this.get = function(key, opts, cb) {
    return this.db.get(key, opts, cb);
  };

  this.put = function(key, value, opts, cb) {
    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }    
    opts = opts || {};

    // if listening
    if(this.opts.listen) {
      if(!cb) return this.db.put(key, value, opts);
      this._ignore('put', key, value); // make listener ignore this next put
    }

    var self = this;
    this.db.put(key, value, opts, function(err) {
      if(err) return cb(err);

      self._onChange({type: 'put', key: key, value: value, cb: cb});
    });
  };

  this.del = function(key, opts, cb) {
    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }    
    opts = opts || {};

    // if listening
    if(this.opts.listen) {
      if(!cb) return this.del.put(key, opts);
      this._ignore('del', key, value); // make listener ignore this next del
    }

    var self = this;
    this.db.del(key, opts, function(err) {
      if(err) return cb(err);

      self._onChange({type: 'del', key: key, cb: cb});
    });
  };

  this.batch = function(ops, opts, cb) {
    if(!ops) throw new Error("Chained form of batch not yet supported");

    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }    
    opts = opts || {};

    var i;

    // if listening
    if(this.opts.listen) {
      if(!cb) return this.db.batch(ops, opts);
      for(i=0; i < ops.length; i++) {
        this._ignore('batch', ops[i]); // make listener ignore this operation
      }
    }

    var self = this;
    this.db.batch(ops, opts, function(err) {
      if(err) return cb(err);

      if(ops.length === 0) {
        if(cb) cb();
        return;
      }

      var opsCompleted = 0;

      function opCompleted(err) {
        if(err) cb(err);

        opsCompleted++;
        // run callback when all operations in this batch have completed
        if(opsCompleted >= ops.length) {
          cb();
        }
      }

      for(i=0; i < ops.length; i++) {
        // trigger callback when the last op finishes processing
        self._onChange({type: ops[i].type, key: ops[i].key, value: ops[i].value, cb: opCompleted});
      }
    });
  };

  // TODO auto-detect if amino acid or nucleotides
  this.query = function(seq, opts, cb) {
    var self = this;
    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    function error(err) {
      if(typeof cb === 'function') {
        return cb(new Error(err));
      }
      throw new Error(err);
    }

    if(!self._hasBlastDBs()) {
      return error("No blast index. Make sure your database isn't empty, then call .rebuild to build the blast index.");
    }

    opts = xtend({

      // output defaults to 'array' if cb is specified and 'stream' if not
      output: undefined, // 'stream', 'array', 'blast' or 'blastraw',
      type: (this.opts.type === 'aa') ? 'blastp' : 'blastn' // can be 'blastn', 'blastp', 'blastx', 'tblastx' or 'tblastn'
    }, opts || {});

    // assume that output is stream 
    if(cb) {
      opts.output = opts.output || 'array';
    } else {
      opts.output = 'stream';
    }

    // TODO support 'blast' and 'blastraw' outputs
    if(opts.output == 'blast' || opts.output == 'blastraw') {
      throw new Error("TODO not implemented");
    }

    // check if opts.type is sane
    if(this.opts.type === 'aa')  {
      if(['blastp', 'blastx'].indexOf(opts.type) < 0) {
        error("invalid query type attempted on protein database");
      }
    } else { // this.opts.type === 'nt'
      if(['blastn', 'tblastx', 'tblastn'].indexOf(opts.type) < 0) {
        error("invalid query type attempted on nucleotide database");
      }
    }

    var qdbs =  this._queryDBs();
    this._changeQueryCount(qdbs, 1);

    var dbName = qdbs.join(' ');
    var cmd, args;

    var task = opts.type;

    if(seq.length < 30) { // auto-switch to '-short' tasks for blastn and blastp
      if(task === 'blastn') {
        task = 'blastn-short';
      } else if(type === 'blastp') {
        task = 'blastp-short';
      }
    }

    if(opts.type === 'blastn' || opts.type === 'blastp') {
      cmd = path.join(this.opts.binPath, opts.type);
      args = ["-task", task, "-outfmt", "15", "-db", dbName];
    } else {
      // TODO support blastx, tblastx and tblastn
      error("only blastn and blastp queries are supported for now");
    }

//    console.log("RUNNING:", cmd, args.join(' '));
    var outStream;
    if(opts.output === 'stream') {
      outStream = new PassThrough({objectMode: true});

      // create a callback that emits an error or ends the stream
      cb = function(err, results) {
        if(err) {
          outStream.emit('error', err);
          return;
        }
        if(!results || !results.length) {
          from.obj(function(size, next) {
            next(null, null); // end stream
          }).pipe(outStream);
        }
      };
    }

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

      if(!output) {
        return cb(null, []);
      }

      if(opts.output === 'blastraw') {
        return cb(null, output);
      }

      if(!output.BlastOutput2 || !output.BlastOutput2.length || !output.BlastOutput2[0] || !output.BlastOutput2[0].report || !output.BlastOutput2[0].report.results || !output.BlastOutput2[0].report.results.search || !output.BlastOutput2[0].report.results.search.hits || !output.BlastOutput2[0].report.results.search.hits.length) {
        return cb(null, []);
      }

      if(opts.output === 'blast') {
        return cb(null, output.BlastOutput2[0].report.results.search.hits);
      }

      output = output.BlastOutput2[0].report.results.search.hits;

      // keep track of hits to avoid dupes
      var hits = {};

      var i = 0;

      function nextResult(size, next) {
        if(i > output.length - 1) return next(null, null);

        var cur = output[i++];
        self._levelRowFromBlastHit(cur, function(err, row) {
          if(err) return cb(err);

          // If this blast hit didn't have a value in the database
          // then it must have been deleted from leveldb since the
          // blast database was last rebuilt. Just skip it.
          if(!row) {
            return process.nextTick(function() {
              nextResult(size, next);
            });
          }

          next(null, row);
        })
      }

      var s = from.obj(nextResult);

      if(outStream) {
        s.pipe(outStream);
        // forward errors
        s.on('error', function(err) {
          outStream.emit('error', err);
        })
        return;
      } else {

        var results = [];
        s.on('data', function(data) {
          results.push(data);
        });

        s.on('end', function() {
          cb(null, results);
        });
        s.on('error', cb);
      }
    });

    blast.stdin.end(seq, 'utf8');

    if(outStream) {
      return outStream;
    }
  };

  this.rebuild = function(cb) {
    this._rebuild('main', cb);
  };

  this.check = function(cb) {
    checkCommands(this.opts.binPath, cb);
  };

  this.status = function(cb) {
    var stat = {
      opts: xtend(this.opts, {}) // clone opts
    };

    if(this.opts.mode !== 'blastdb') {
      process.nextTick(function() {
        cb(null, stat);
      });
      return;
    }
    var self = this;
    
    var mainDBName = this._dbName('main');
    dbInfo(this.opts.path, mainDBName, function(err, info) {
      if(err) return cb(err);

      stat.mainDB = info;

      var updateDBName = self._dbName('update');

      dbInfo(self.opts.path, updateDBName, function(err, info) {
        if(err) return cb(err);      

        stat.updateDB = info;

        if(!stat.mainDB || !stat.updateDB) {
          stat.ratio = 1;
        } else {
          stat.ratio = (stat.mainDB.size / (stat.mainDB.size + stat.updateDB.size)).toFixed(2);
        }

        stat.shouldRebuild = (stat.ratio < 0.9);

        cb(null, stat);
      });
    });
  };

  this._init();
};

util.inherits(BlastLevel, EventEmitter);

BlastLevel.check = checkCommands;

module.exports = BlastLevel;
