#!/usr/bin/env node

var tmp = require('tmp');
var memdb = require('memdb');
var blastLevel = require('../index.js');

tmp.setGracefulCleanup(); // clean up even on uncaught exception

var db = memdb({valueEncoding: 'json'});

// create temporary dir for blast db storage
var tmpDir = tmp.dirSync({
  unsafeCleanup: true // auto-delete dir on close, even if it isn't empty
//  keep: true // don't delete on exit
});


var blastDB = blastLevel(db, {
  seqProp: 'seq', // key in 'mydb' that stores the sequence data
  changeProp: 'updated',
  path: tmpDir.name, // directory to use for storing BLAST db
  listen: true, // listen for changes on level db and auto update BLAST db
  //    debug: true
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
  seq: "GATTACACATTACA",
  updated: new Date().getTime()
}, function(err) {
  if(err) fail(err);

  console.log("added foo");

  console.log("building blast index");

  
  db.put('bar-'+r(), {
    seq: "CATCATCATATTACACATTACCATCATCAT",
    updated: new Date().getTime()
  }, function(err) {
    if(err) fail(err);
    
    console.log("added bar");    
    
    db.put('baz-'+r(), {
      seq: "CATCATCATATTACACAAAAAAAAAAAAAAAAAAA",
      updated: new Date().getTime()
    }, function(err) {
      if(err) fail(err);
      
      console.log("added baz");
      
      db.put('fourth-'+r(), {
        seq: "CATCATCATATTACACAAAAAAAAAAAAAAAAAAA",
        updated: new Date().getTime()
      }, function(err) {
        if(err) fail(err);
        
        console.log("added fourth");
        
        setTimeout(function() {

          var s = blastDB.query("ATTACACATTAC");

          s.on('data', function(data) {
            console.log("result:", data);
          });

          s.on('error', function(err) {
            console.error("stream error:", err);
          });

          s.on('end', function() {
            console.log("end of blast results");
          });
          
        }, 500); 
      });
    });
  });
});

