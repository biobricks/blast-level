/*

  Update:

  State: Update db is called 'update'.

  Increment oneshot counter and generate new dir-unique db name: oneshot1

  Write single sequence to new db with name 'oneshot1'.

  Increment update counter and generate new dir-unique db name: update1

  Concat db 'oneshot1' with 'update' to create 'update1'.
  Ensure that newest updates are first to queries will give newest results first.

  Change currently active main db name from 'update' to 'update1'

  if active_query_count['update'] is zero
    Delete old db 'update'.

  After a query on an update db completes, check if the active_query_count for any non-primary databases have dropped to zero and if so delete them. Before each query on an update db increment the active query count for it.
  
  When initialized the name of the current update db should be found by looking for the db called 'update*.nin' that was most recently modified or with the largest file size (looking at file size would protect against opening a partially written db in case of a crash).

*/

var spawn = require('child_process').spawn;
var fs = require('fs');
var util = require('util');
var path = require('path');
var xtend = require('xtend');
var bytewise = require('bytewise');
var defaults = require('levelup-defaults');
var tmp = require('tmp');
var levelup = require('levelup');
var through = require('through2');
var from = require('from2');
var async = require('async');
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;

function BlastLevel(db, opts) {
    if(!(this instanceof BlastLevel)) return new BlastLevel(db, opts);

    opts = xtend({
        mode: 'blastdb', // or 'direct' or 'streaming' (slow)
        rebuildOnOpen: false, // rebuild the BLAST index when dbs is opened
        rebuildOnChange: false, // rebuild the main BLAST index whenever the db is changed
        keepUpdateIndex: true, // keep changes since last rebuild in separate BLAST index
        binPath: '', // path where BLAST+ binaries are located in not in PATH
        threadsPerQuery: 1, // TODO how many threads (CPUs) to use for a single query 
        debug: false // turn debug output on or off
    }, opts);
    this._opts = opts;

    this._dbs = {
        rebuildCount: 0, // number of rebuilds completed
        'main': {
            lastRebuild: 0, // number of last completed rebuild
            exists: false
        },
        'update': {
            lastRebuild: 0,
            exists: false
        }
    };

    this._queryCount = {}; // number of active queries for each db, indexed by name
    this._toDelete = [];

    if(!opts.sequenceKey) {
        throw new Error("opts.sequenceKey must be specified");
    }
    this._key = opts.sequenceKey;

    if(!opts.path) {
        throw new Error("opts.path must be specified");
    }
    this._path = opts.path;

    if(!db || !db.location) {
        throw new Error("First argument must be a level instance");
    }

    this._dbOpts = {
        keyEncoding: 'utf8', 
        valueEncoding: 'json'
    };

    AbstractLevelDOWN.call(this, db.location);
    this.db = defaults(db, this._dbOpts);
}

util.inherits(BlastLevel, AbstractLevelDOWN);

BlastLevel.prototype._open = function(opts, cb) {
    var self = this;

    function doesBlastDBExist(dbName, cb) {
        var dbPath = path.join(self._path, dbName+'.nin');
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
    }

    function checkDB(which, create, cb) {
        var dbName = self._dbName(which);

        fs.stat(self._path, function(err, stats) {
            if(err) {
                if(err.code === 'ENOENT') {
                    fs.mkdir(self._path, function(err) {
                        if(err) return cb(err);
                        if(!create) return cb()
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

            doesBlastDBExist(dbName, function(err, exists) {
                if(err) return cb(err);
                if(exists) {
                    self._dbs[which].exists = true;
                    return cb();
                }
                if(!create) return cb()
                self._rebuild(dbName, cb);
            });
        });
    }

    function opened(opts, cb) {
        if(self._opts.rebuildOnOpen) return self._rebuild('main', cb);

        checkDB('main', self._opts.rebuildOnOpen, function(err) {
            if(err) return cb(err);
            checkDB('update', false, cb);
        });
    }

    if(this.db.isOpen()) {
        return opened(opts, cb)
    }
    
    this.db.on('open', this.open.bind(this, opts, cb));

//    tmp.dir(function _tempDirCreated(err, path, cleanupCallback) {
};

BlastLevel.prototype._close = function(cb) {
    this.db.close(cb);
};


BlastLevel.prototype._get = function(key, opts, cb) {
    this.db.get(key, opts, cb);
};

// get the sequence data from a leveldb value
BlastLevel.prototype._seqFromVal = function(val) {
    return val[this._key];
}

BlastLevel.prototype._put = function(key, value, opts, cb) {
    var self = this;

    if(!this._opts.rebuildOnChange) {
        var val = JSON.parse(value);
        return this.db.put(key, val, opts, function(err) {
            if(err) return cb(err);
            if(self._opts.keepUpdateIndex) {
                self._rebuild('update', {key: key, value: val}, cb);
            } else {
                cb();
            }
        });
    }

    var self = this;
    this.db.put(key, JSON.parse(value), opts, function(err) {
        self._rebuild('main', cb);
    });
};


BlastLevel.prototype._del = function(key, opts, cb) {
    this.db.del(key, opts, cb);
};

BlastLevel.prototype._batch = function(array, opts, cb) {

    // TODO

    return this.db.batch(key, opts, cb);
};


BlastLevel.prototype._debug = function(msg) {
    if(!this._opts.debug) return;
    console.log('[debug]', msg);
};


BlastLevel.prototype._changeQueryCount = function(names, num) {
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

/*
BlastLevel.prototype._createBlastDB = function(dbName, cb) {
    var self = this;

    self._debug("Running _createBlastDB for", dbName);

    self.__createBlastDB(dbName, function(err, count) {
        if(err) return cb(err);
        if(count == 0) {
            self._dbState[dbName] = false;
        } else {
            self._dbState[dbName] = true;
        }
        cb();
    });
}
*/

// Builds a blast db from all sequences in the leveldb instance
// or from a specified readable stream
// callback gives back args:
//   err
//   count: number of sequences added to database
// If count is 0 then no database was created since makeblastdb
// will not create empty databases
// Set opts.stream to a stream outputting FASTA sequences 
// or a stream will be created outputting all sequences in the level db
BlastLevel.prototype._createBlastDB = function(name, opts, cb) {
    var self = this;

    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    
    var dbPath = path.join(self._path, name);
    console.log("CREATING", dbPath);

    var cmd = path.join(this._opts.binPath, "makeblastdb");
    var args = ["-dbtype", "nucl", "-title", "'blastlevel'", "-out", dbPath];
    
    var makedb = spawn(cmd, args);

    var seqStream = this._seqStream();

    if(opts.stream) {
        opts.stream.pipe(seqStream);
    } else {
        this.db.createReadStream({valueEncoding: 'json'}).pipe(seqStream);
    }

    seqStream.pipe(makedb.stdin);

    var stdoutClosed = false;
    var stderrClosed = false;
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

    // TODO act on makedb.close instead!
    makedb.stdout.on('close', function() {
        stdoutClosed = true;
        if(stderrClosed) {
            stderr = stderr ? new Error(stderr) : undefined;
            cb(stderr, addedCount)
        }
    });


    makedb.stderr.on('data', function(data) {
        stderr += data.toString();
    });    
    
    makedb.stderr.on('close', function() {
        // Ignore "no sequences added" errors
        m = stderr.match(/No sequences added/i);
        if(m) stderr = '';
        stderrClosed = true;
        if(stdoutClosed) {
            stderr = stderr ? new Error(stderr) : undefined;
            cb(stderr, addedCount)
        }
    });
};

// Take a leveldb entry object (with .key and .value) 
// and turn it into fasta-formatted output that can be
// referenced back to the leveldb entry
BlastLevel.prototype._fastaFormat = function(data) {
    var line = "> id:" + data.key + "\n" + this._seqFromVal(data.value) + "\n";
    return line;
};


// Takes as input the output from blastn of one result
// Gets the levedb entry for the result and calls callback with args:
//   err
//   id (leveldb key)
//   leveldb value
//   blastn query result
BlastLevel.prototype._blastnParse = function(result, cb) {
    var m = result.match(/^>\s+id:([^\s]+)/)
    if(!m) return cb("Invalid blastn query result");

    var id = m[1];
    this.db.get(id, function(err, val) {
        if(err) return cb(err);
        cb(null, id, val, result);
    });
};


// parse blastn result stream
// resultCb is called for each result with args:
//   id (leveldb key)
//   leveldb value
//   blastn query result
// endCb is called when stream ends or on error with:
//   err
//   resultCount: number of parsed results
BlastLevel.prototype._blastnParseStream = function(stream, resultCb, endCb) {
    var self = this;
    var buffer = '';
    var count = 0;

    var m;
    var indexes = [];
    var result;
    var didErr = false;

    function loopWhile(cb) {
        m = buffer.match(/^>/g);
        if(!m) return cb();
        console.log('!!!', m);
        indexes.push(m.index);
        if(indexes.length < 2) return loopWhile(cb);

        result = buffer.substring(indexes[0], indexes[1]-1);            
        buffer = buffer.substring(indexes[1]);

        indexes = [];
        count++;

        self._blastnParse(result, function(err, id, val, result) {
            if(err) {
                didErr = true;
                return endCb(err);
            }
            resultCb(id, val, result);
            loopWhile(cb);
        });

    }

    stream.pipe(through(function(data, enc, cb) {
        buffer += data.toString();
        loopWhile(cb);
    }));

    stream.on('end', function() {
        if(didErr) return;
        var m = buffer.match(/^>/m);
        if(!m) return endCb(null, count)

        var result = buffer.substring(m.index);
        count++;

        // TODO check for "Effective search space used" to cut off ending

        self._blastnParse(result, function(err, id, val, result) {
            resultCb(id, val, result);
            endCb(null, count);
        })
    });
}


// create stream of sequences
BlastLevel.prototype._seqStream = function() {
    var self = this;

    var seqStream = through.obj(function(data, enc, cb) {
        console.log(data);
        if(data.value && self._seqFromVal(data.value)) {
            this.push(self._fastaFormat(data));
        }
        cb();
    });

    return seqStream;
};

// do any blast databases currently exist?
BlastLevel.prototype._hasBlastDBs = function() {
    if(this._dbs['main'].exists || this._dbs['update'].exists) {
        return true;
    }
    return false;
}


// name of current db
BlastLevel.prototype._dbName = function(which) {
    if(!this._dbs[which].exists) return null;
    return this._numberToDBName(which, this._dbs[which].lastRebuild);
}


BlastLevel.prototype._numberToDBName = function(which, number) {
    return which + '-' + number;
}

/*
update 1
main 2
update 3
main 4
*/

// rebuild a blast db
// which is either 'main' or 'update'
// data is optionally a single {key: ..., value: ...} object
// to build the database from
BlastLevel.prototype._rebuild = function(which, data, cb) {
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
            console.log("--------------", self._dbs['update'].exists, buildNum, self._dbs['update'].lastRebuild);
            if(self._dbs['update'].exists && (buildNum > self._dbs['update'].lastRebuild)) {
                var lastUpdateName = self._numberToDBName('update', self._dbs['update'].lastRebuild);
                self._attemptDelete(lastUpdateName)
                self._dbs['update'].exists = false;
            } 
        }
        cb();
    });
};


// delete all dbs that are queued for deletion and
// which no longer have any running queries
BlastLevel.prototype._processDeletions = function(cb) {
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

BlastLevel.prototype._deleteDB = function(name, cb) {
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
        fs.unlink(path.join(self._path, name+'.'+ext), cb);
    }, function(err) {
        if(err) return cb(err);
    });
};



// this function ignore the data argument for now
BlastLevel.prototype._rebuildMainDB = function(dbName, data, cb) {
    var self = this;

    this._createBlastDB(dbName, function(err, count) {
        if(err) return cb(err);

        self._dbs['main'].exists = (count == 0) ? false : true;

        cb();
    });
};

// create a stream that emits the single object: data
BlastLevel.prototype._singleObjectStream = function(data) {
    var done = false;
    // create a stream that emits a single object and closes
    return from.obj(function(size, next) {
        if(done) return next(null, null);
        done = true;    
        next(null, data);
    });
};

BlastLevel.prototype._rebuildUpdateDB = function(dbName, data, cb) {
    var self = this;

    if(!this._dbs['update'].exists) {
        // build update db from single sequence
        // data should have data.key and data.value

        var s = this._singleObjectStream(data);

        this._createBlastDB(dbName, {stream: s}, function(err) {
            if(err) return cb(err);

            self._dbs['update'].exists = true;
            cb();
        });
        

    } else {
        throw new Error("TODO not implemented");
        /*
          Should use BLAST concat:
          
          makeblastdb -dbtype nucl -title 'newdb' -in '/path/to/existing/db /tmp/to_append' -input_type blastdb -out /path/to/concatenated/db
          
          and blastdb_aliastool (or can you pass multiple dbs to blastn?)
          
        */
    }
};

// get db name(s) to use for queries
BlastLevel.prototype._queryDBs = function() {
    var maindb = this._dbName('main');
    var updatedb = this._dbName('update');
    var dbs = [];
    if(maindb) dbs.push(maindb);
    if(updatedb) dbs.push(updatedb);
    return dbs;
};

BlastLevel.prototype._attemptDelete = function(dbName) {
    this._toDelete.push(dbName);
    this._processDeletions();
}

// TODO auto-detect if amino acid or 
BlastLevel.prototype.query = function(seq, opts, resultCb, endCb) {
    var self = this;
    if(typeof opts === 'function') {
        endCb = resultCb;
        resultCb = opts;
        opts = {};
    }
    if(!self._hasBlastDBs()) {
        return endCb(new Error("No blast index. Make sure your database isn't empty, then call .rebuild to build the blast index."));
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
        cmd = path.join(this._opts.binPath, "blastn");
        args = ["-task", "blastn-short", "-db", dbName];
    } else {
        // TODO support blastp
        throw new Error("blastp not implemented");
    }

    function end(err) {
        self._changeQueryCount(qdbs, -1);
        self._processDeletions(); // callback doesn't have to wait for this
        endCb(err);
    }
    

//    console.log("CMD", cmd, args.join(' '));
    var blast = spawn(cmd, args, {
        cwd: this._path
    });

    var stdoutClosed = false;
    var cmdClosed = false;
    var stderr = '';

    blast.stdout.on('data', function(str) {
        self._debug("["+opts.type+" stdout] " + str);
    });

    blast.stderr.on('data', function(data) {
        stderr += data.toString();
    });    
    

    blast.on('close', function(code) {
        cmdClosed = true;
        if(code) {
            stderr = stderr || "blast command exited with non-zero exit code";
        }
        if(!stdoutClosed) return;

        if(stderr) return end(new Error(stderr));
        end();
    });
    self._blastnParseStream(blast.stdout, function(dbKey, dbVal, result) {
        resultCb({
            key: dbKey,
            value: dbVal
        });
    }, function(err, count) {
        stdoutClosed = true;
        if(err) {
            stderr = err.message + "\n" + stderr;
        }
        if(!cmdClosed) return;

        if(stderr) return end(new Error(stderr));
        end();
    });


    blast.stdin.on('error', function(err) {
        // these error messages are rarely useful
        // and are accompanied by more useful .stderr messages
        // so just make sure they're handled and throw away the message
    });


    blast.stdin.end(seq, 'utf8');

};

BlastLevel.prototype.rebuild = function(cb) {
    this._rebuild('main', cb);
};


module.exports = function(db, opts) {

    var blastLevel;

    function getInstance(db, opts2) {
        blastLevel = new BlastLevel(db, opts);
        return blastLevel;
    }

    opts = xtend({
        db: getInstance,
        keyEncoding: 'utf8',
        valueEncoding: 'json'
    }, opts || {});


    var lup = levelup(db, opts);

    // expose non-leveldb functions
    lup.query = blastLevel.query.bind(blastLevel);
    lup.rebuild = blastLevel.rebuild.bind(blastLevel);


    return lup;
};
