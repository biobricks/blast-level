#!/usr/bin/env node

var tmp = require('tmp');
var memdb = require('memdb');
var blastLevel = require('../index.js');

tmp.setGracefulCleanup(); // clean up even on uncaught exception

var db = memdb({valueEncoding: 'json'});

// create temporary dir for blast db storage
var tmpDir = tmp.dirSync({
//  unsafeCleanup: true // auto-delete dir on close, even if it isn't empty
  keep: true // don't delete on exit
});


var blastDB = blastLevel(db, {
  seqProp: 'seq', // key in 'mydb' that stores the sequence data
//  path: tmpDir.name, // directory to use for storing BLAST db
  path: '/tmp/foo',
//  rebuild: true, // rebuild the BLAST index when the db is opened
  rebuildOnChange: false,
  listen: true, // listen for changes on level db and auto update BLAST db
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

setTimeout(function() {

db.put('foo-'+r(), {
  seq: "GATTACACATTACA"
}, function(err) {
  if(err) fail(err);

  console.log("added foo");

  console.log("building blast index");

  
  db.put('bar-'+r(), {
    seq: "CATCATCATATTACACATTACCATCATCAT"
  }, function(err) {
    if(err) fail(err);
    
    console.log("added bar");    

    setTimeout(function() {
      
      db.put('baz-'+r(), {
        seq: "CATCATCATATTACACAAAAAAAAAAAAAAAAAAA"
      }, function(err) {
        if(err) fail(err);
        
        console.log("added baz");
        
        db.put('fourth-'+r(), {
          seq: "CATCATCATATTACACAAAAAAAAAAAAAAAAAAA"
        }, function(err) {
          if(err) fail(err);
          
          console.log("added fourth");
          
          
        });
      });

    }, 500);
  });


})

}, 1000);
