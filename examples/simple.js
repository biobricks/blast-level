#!/usr/bin/env node

var level = require('level');
var blastLevel = require('../index.js');

var db = level('/tmp/mydb', {valueEncoding: 'json'});

var blastDB = blastLevel(db, {
    seqProp: 'seq', // key in 'mydb' that stores the sequence data
    path: '/tmp/blastdb', // directory to use for storing BLAST db
    rebuildOnOpen: false, // rebuild the BLAST index when the db is opened
    rebuildOnChange: false, // rebuild the BLAST index whenever the db is updated
//    keepUpdateIndex: false,
//    debug: true,
    binPath: "/home/juul/projects/bionet/blast/ncbi-blast-2.4.0+/bin"
});

blastDB.on('error', function(err) {
    console.error("Error:", err);
});

function r() {
    return Math.round(Math.random() * 10000).toString();
}

function fail(err) {
    console.error(err);
    process.exit(1);
}

db.put('foo-'+r(), {
    seq: "GATTACACATTACA"
}, function(err) {
    if(err) fail(err);

    console.log("added foo");

    console.log("building blast index");
    
    blastDB.rebuild(function(err) {
        if(err) return console.error("Error:", err);
        
        db.put('bar-'+r(), {
            seq: "CATCATCATATTACACATTACCATCATCAT"
        }, function(err) {
            if(err) fail(err);
            
            console.log("added bar");
            
            
            console.log("rebuilding blast index");
            
            blastDB.rebuild(function(err) {
                if(err) return console.error("Error:", err);
                
                console.log("running blast query");
                
                blastDB.query("ATTACACATTAC", function(data) {
                    
                console.log("Got result:", data.key);
                    
                }, function(err) {
                    if(err) return console.error("Error:", err);
                    
                    console.log("end of results");
                    
                });
            });
        });
    });
})

/*

echo -e "> foo\nGATTACACATTACA" | ./blastn -db /tmp/blastdb/main -task blastn-short

*/
