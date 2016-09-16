
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
        autoUpdate: true,
        updateOnOpen: true,
        binPath: '',
        debug: false
    }, opts);
    this._opts = opts;

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

    function opened() {
        fs.stat(self._path, function(err, stats) {
            if(err) {
                if(err.code === 'ENOENT') {
                    fs.mkdir(self._path, function(err) {
                        if(err) return cb(err);
                        self._createBlastDB('main', cb);
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
                self._createBlastDB('main', cb);
            });
        });
        
    }

    if(this.db.isOpen()) {
        return opened()
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
};

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

    var seqStream = this._seqStream();

    seqStream.pipe(makedb.stdin);

    // TODO 
    makedb.stdout.on('data', function(data) {
        console.log("[makeblastdb]", data.toString());
    });

    makedb.stderr.on('data', function(data) {
        console.log("[makeblastdb err]", data.toString());
    });    

    cb();
};

// create stream of sequences
BlastLevel.prototype._seqStream = function() {
    var self = this;

    var line;
    // TODO check if nothing emitted (which means no db created)
    var seqStream = through.obj(function(data, enc, cb) {
        if(data.value && data.value[self._key]) {
            line = "> " + data.key + "\n" + data.value[self._key] + "\n";
            this.push(line);
        }
        cb();
    });

    this.db.createReadStream({valueEncoding: 'json'}).pipe(seqStream);

    return seqStream;
};

module.exports = function(db, opts) {

    function getInstance(db, opts2) {
        return new BlastLevel(db, opts);
    }

    opts = xtend({
        db: getInstance,
        keyEncoding: 'utf8',
        valueEncoding: 'json'
    }, opts || {});


    return levelup(db, opts);
};
