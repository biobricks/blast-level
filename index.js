
var fs = require('fs');
var path = require('path');
var xtend = require('xtend');
var bytewise = require('bytewise');
var defaults = require('levelup-defaults');
var tmp = require('tmp');

function BlastLevel(db, opts) {
    if(!(this instanceof BlastLevel)) return new BlastLevel(db, opts);

    opts = xtend({
        auto_update: true,
        debug: false
    }, opts);
    this.opts = opts;

    if(!opts.sequenceKey) {
        throw new Error("opts.sequenceKey must be specified");
    }
    this.key = opts.sequenceKey;

    if(!opts.path) {
        throw new Error("opts.path must be specified");
    }
    this.path = opts.path;

    if(!db || !db.location) {
        throw new Error("First argument must be a level instance");
    }

    this._dbOpts = {
        keyEncoding: bytewise, 
        valueEncoding: 'json'
    };

    AbstractLevelDOWN.call(this, db.location);
    this.db = defaults(db, this._dbOpts);
}

util.inherits(BlastLevel, AbstractLevelDOWN);

BlastLevel.prototype._open = function(opts, cb) {
    
    var self = this;

    function doesBlastDBExist(cb) {
        var dbPath = path.join(self.path, 'main.nin');
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
        fs.stat(self.path, function(err, stats) {
            if(err) {
                if(err.code === 'ENOENT') {
                    fs.mkdir(self.path, function(err) {
                        if(err) return cb(err);
                        self._createBlastDB('main', cb);
                    });
                } else {
                    return cb(err):
                }
            }
            if(!stats.isDirectory()) {
                return cb(new Error("Specified path must be a directory"));
            }
            doesBlastDBExist(function(err, exists) {
                if(err) return cb(err);
                if(exists) {
                    if(self.opts.updateOnOpen) return self._rebuildBlastDB(cb);
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
    return this.db.get(key, opts, cb);
};

BlastLevel.prototype._put = function(key, value, opts, cb) {


};


BlastLevel.prototype._del = function(key, opts, cb) {


};

BlastLevel.prototype._batch = function(array, opts, cb) {


};


BlastLevel.prototype._createBlastDB = function(name, opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }

}


module.exports = BlastLevel;
