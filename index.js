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
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;

function BlastLevel(db, opts) {
    if(!(this instanceof BlastLevel)) return new BlastLevel(db, opts);

    opts = xtend({
        autoUpdate: true, // automatically update BLAST db on changes to leveldb (if disabled then you must manually call .update)
        rebuildOnOpen: false, // TODO rebuild the BLAST db when it is opened
        rebuildOnUpdate: false, // TODO rebuild the main BLAST db on every update
        binPath: '', // path where BLAST+ binaries are located in not in PATH
        threadsPerQuery: 1, // TODO how many threads (CPUs) to use for a single query 
        debug: false // turn debug output on or off
    }, opts);
    this._opts = opts;

    this._mainDB = 'main'; // name of main BLAST db
    this._updateDB = 'update'; // name of BLAST db where updates are written

    // db state is undefined if unknown, true if it exists and false if it doesn't
    this._dbState = {};
    this._dbState[this._mainDB] = undefined;
    this._dbState[this._updateDB] = undefined;

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

    function checkDB(dbName, create, cb) {
        fs.stat(self._path, function(err, stats) {
            if(err) {
                if(err.code === 'ENOENT') {
                    self._dbState[dbName] = false;
                    if(!create) return cb()
                    fs.mkdir(self._path, function(err) {
                        if(err) return cb(err);
                        self._createBlastDB(dbName, cb);
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
                    self._dbState[dbName] = true;
                    return cb();
                }
                self._dbState[dbName] = false;
                if(!create) return cb()
                self._createBlastDB(dbName, cb);
            });
        });
    }

    function opened(opts, cb) {
        if(self._opts.rebuildOnOpen) return self._rebuildBlastDB(cb);
        checkDB(self._mainDB, true, function(err) {
            if(err) return cb(err);
            checkDB(self._updateDB, false, cb);
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

BlastLevel.prototype._put = function(key, value, opts, cb) {
    this.db.put(key, JSON.parse(value), opts, cb);
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


// Builds a blast db from all sequences in the leveldb instance
// or from a specified readable stream
// callback gives back args:
//   err
//   count: number of sequences added to database
// If count is 0 then no database was created since makeblastdb
// will not create empty databases
// Set opts.stream to a stream outputting FASTA sequences 
// or a stream will be created outputting all sequences in the level db
BlastLevel.prototype.__createBlastDB = function(name, opts, cb) {
    var self = this;

    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    
    var dbPath = path.join(self._path, 'main');

    var cmd = path.join(this._opts.binPath, "makeblastdb");
    var args = ["-dbtype", "nucl", "-title", "'blastlevel'", "-out", dbPath];
    
    var makedb = spawn(cmd, args);

    var seqStream;

    if(opts.stream) {
        seqStream = stream;
    } else {
        seqStream = this._seqStream();
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
    var line = "> id:" + data.key + "\n" + data.value[this._key] + "\n";
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
        if(data.value && data.value[self._key]) {
            this.push(self._fastaFormat(data));
        }
        cb();
    });

    this.db.createReadStream({valueEncoding: 'json'}).pipe(seqStream);

    return seqStream;
};

// do any blast databases currently exist?
BlastLevel.prototype._hasBlastDBs = function() {
    if(this._dbState[this._mainDB] || this._dbState[this._updateDB]) {
        return true;
    }
    return false;
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
        return endCb();
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

    var dbPath = path.join(self._path, 'main');
    var cmd, args;

    if(opts.type === 'blastn') {
        cmd = path.join(this._opts.binPath, "blastn");
        args = ["-task", "blastn-short", "-db", dbPath];
    } else {
        throw new Error("blastp not implemented");
    }

    var blast = spawn(cmd, args);

    var stdoutClosed = false;
    var stderrClosed = false;
    var stderr = '';

    blast.stdout.on('data', function(str) {
        self._debug("["+opts.type+" stdout] " + str);
    });

    blast.stderr.on('data', function(data) {
        stderr += data.toString();
    });    
    
    blast.stderr.on('close', function() {
        stderrClosed = true;
        if(stdoutClosed) {
            stderr = stderr ? new Error(stderr) : undefined;
            endCb(stderr)
        }
    });
    
    self._blastnParseStream(blast.stdout, function(dbKey, dbVal, result) {
        resultCb({
            key: dbKey,
            value: dbVal
        });
    }, function(err, count) {
        stdoutClosed = true;
        if(!stderrClosed) return;
        if(err) {
            if(stderr) {
                stderr = err.message + "\n" + stderr;
                return endCb(new Error(stderr));
            }
            return endCb(err);
        }
        endCb();
    });


    blast.stdin.on('error', function(err) {
        // these error messages are rarely useful
        // and are accompanied by more useful .stderr messages
        // so just make sure they're handled and throw away the message
    });


    blast.stdin.end(seq, 'utf8');

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


    return lup;
};
