module.exports = function(cb,opts) {
    var memdb = require('memdb');
    var blastLevel = require('../../index.js');
    var db = memdb({valueEncoding: 'json'});

    // create temporary dir for blast db storage
    // and always clean it up after
    var tmp = require('tmp')
    tmp.setGracefulCleanup()
    var tmpDir = tmp.dirSync({
        unsafeCleanup: true
    });

    var xtend = require('xtend');

    opts = xtend({
        path: tmpDir.name, // directory to use for storing BLAST db
    }, opts || {});

    var blastDB = blastLevel(db, opts);

    cb(db, blastDB);
}
