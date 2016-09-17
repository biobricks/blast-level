
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
        autoUpdate: true, // automatically update BLAST db on changes to leveldb
        rebuildOnOpen: false, // rebuild the BLAST db when it is opened
        rebuildOnUpdate: false, // rebuilt the main BLAST db on every update
        binPath: '', // path where BLAST+ binaries are located in not in PATH
        debug: false // turn debug output on or off
    }, opts);
    this._opts = opts;

    this._mainDB = 'main'; // name of main BLAST db
    this._updatesDB = 'updates'; // name of BLAST db where updates are written

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

    function doesBlastDBExist(cb) {
        var dbPath = path.join(self._path, 'main.nin');
        fs.stat(dbPath, function(err, stats) {
            if(err) {
                if(err.code == 'ENOENT') {
                    return cb(null, false);
                } else {
                    return cb(err);
                }
            }
            if(!stats.isFile()) {
                return cb(new Error("Blast DB file isn't a file :/"));
            }
        });
    }

    function createMainDB(cb) {
        self._createBlastDB(self._mainDB, function(err, count) {
            if(err) return cb(err);
            if(count === 0) {
                self._mainDB = null;
            }
            cb();
        });
    }

    function opened(opts, cb) {
        fs.stat(self._path, function(err, stats) {
            if(err) {
                if(err.code === 'ENOENT') {
                    fs.mkdir(self._path, function(err) {
                        if(err) return cb(err);
                        createMainDB(cb);
                    });
                    return;
                } else {
                    return cb(err);
                }
            }

            if(!stats.isDirectory()) {
                return cb(new Error("Specified path must be a directory"));
            }
            doesBlastDBExist(function(err, exists) {
                if(err) return cb(err);
                if(exists) {
                    if(self._opts.updateOnOpen) return self._rebuildBlastDB(cb);
                    return cb();
                }
                createMainDB(cb);
            });
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

// callback gives back args:
//   err
//   count: number of sequences added to database
// If count is 0 then no database was created since makeblastdb
// will not create empty databases
// Set opts.stream to a stream outputting FASTA sequences 
// or a stream will be created outputting all sequences in the level db
BlastLevel.prototype._createBlastDB = function(name, opts, cb) {
    var self = this;

    self._debug("Running createBlastDB");

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
            stderr = stderr ? undefined : new Error(stderr);
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


// Takes as input the output from nblast of one result
// Gets the levedb entry for the result and calls callback with args:
//   err
//   id (leveldb key)
//   leveldb value
//   nblast query result
BlastLevel.prototype._nblastParse = function(result, cb) {
    var m = result.match(/^>\s+id:([^\s]+)/)
    if(!m) return cb("Invalid nblast query result");

    var id = m[1];
    this.db.get(id, function(err, val) {
        if(err) return cb(err);
        cb(null, id, val, result);
    });
};


// parse nblast result stream
// resultCb is called for each result with args:
//   id (leveldb key)
//   leveldb value
//   nblast query result
// endCb is called when stream ends or on error with:
//   err
//   resultCount: number of parsed results
BlastLevel.prototype._nblastParseStream = function(stream, resultCb, endCb) {
    var buffer = '';
    var count = 0;

    var m;
    var regex = /^>/mg;
    var indexes = [];
    var result;

    stream.pipe(through(function(data, enc, cb) {
        buffer += data.toString();
        while(m = regex.exec(buffer)) {
            indexes.push(m.index);
            if(indexes.length < 2) continue;

            result = buffer.substring(indexes[0], indexes[1]-1);            
            buffer = buffer.substring(indexes[1]);
            indexes = [];
            count++;
            resultCb(result);
        }
        cb();
    }));

    stream.on('end', function() {
        var m = buffer.match(/^>/m);
        if(!m) return endCb(null, count)

        var result = buffer.substring(m.index);
        count++;
        resultCb(result);
        process.nextTick(function() {
            endCb(null, count);
        });
    });
}


// create stream of sequences
BlastLevel.prototype._seqStream = function() {
    var self = this;

    // TODO check if nothing emitted (which means no db created)
    var seqStream = through.obj(function(data, enc, cb) {
        if(data.value && data.value[self._key]) {
            this.push(self._fastaFormat(data));
        }
        cb();
    });

    this.db.createReadStream({valueEncoding: 'json'}).pipe(seqStream);

    return seqStream;
};

BlastLevel.prototype.query = function() {
 // TODO
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


    lup._nblastParseStream = blastLevel._nblastParseStream;

    return lup;
};
