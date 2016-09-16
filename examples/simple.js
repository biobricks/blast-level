#!/usr/bin/env node

var level = require('level');
var blastLevel = require('../index.js');

var db = level('/tmp/mydb', {valueEncoding: 'json'});

var blastDB = blastLevel(db, {
    sequenceKey: 'seq', // key in 'mydb' that stores the sequence data
    path: '/tmp/blastdb', // directory to use for storing BLAST db
    debug: true,
    binPath: "/home/juul/projects/bionet/blast/ncbi-blast-2.4.0+/bin"
});


function fail(err) {
    console.error(err);
    process.exit(1);
}

blastDB.put('foo', {
    seq: "GATTACACATTACA"
}, function(err) {
    if(err) fail(err);

    console.log("added foo");

    blastDB.put('fooo', {
        seq: "CATCATCATCATCAAAAAAAAAAAAT"
    }, function(err) {
        if(err) fail(err);

        console.log("added bar");
    })

})
