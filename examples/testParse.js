#!/usr/bin/env node

var fs = require('fs');
var level = require('level');
var blastLevel = require('../index.js');

var db = level('/tmp/mydb', {valueEncoding: 'json'});

var blastDB = blastLevel(db, {
    sequenceKey: 'seq', // key in 'mydb' that stores the sequence data
    path: '/tmp/blastdb', // directory to use for storing BLAST db
    rebuildOnOpen: true, // rebuild the BLAST db on open
    binPath: "/home/juul/projects/bionet/blast/ncbi-blast-2.4.0+/bin"
});

blastDB.on('error', function(err) {
    console.error("Error:", err);
});


blastDB.on('open', function() {
    var fakeResult = fs.createReadStream('./blastn_example_output', {encoding: 'utf8'})

    console.log("OPENED");

    blastDB._nblastParseStream(fakeResult, function(res) {
        
        console.log("Result:", res);
        
    }, function(err, count) {
        if(err) return console.error("Error:", err);
        
        console.log("Total results:", count);
    });
})
