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
  seqProp: 'seqFile', // key in 'mydb' that stores the sequence data
  seqIsFile: true,
  seqFileBasePath: "../sample_files",
  seqFormatted: true,
  changeProp: 'updated',
  path: tmpDir.name, // directory to use for storing BLAST db
//  path: '/tmp/foo',
//  rebuild: true, // rebuild the BLAST index when the db is opened
  rebuildOnChange: false,
  listen: true, // listen for changes on level db and auto update BLAST db
  binPath: "/home/juul/projects/bionet/blast/ncbi-blast-2.4.0+/bin"
  //    debug: true,
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

db.put('fasta-'+r(), {
  seqFile: "test.fasta",
  updated: (new Date()).getTime()
}, function(err) {
  if(err) fail(err);

  console.log("added fasta");

  console.log("building blast index");

  
  db.put('genbank-'+r(), {
    seqFile: "test.gb",
    updated: (new Date()).getTime()
  }, function(err) {
    if(err) fail(err);
    
    console.log("added genbank");    
    
    db.put('sbol-'+r(), {
      seqFile: "test.sbol",
      updated: (new Date()).getTime()
    }, function(err) {
      if(err) fail(err);
          
      console.log("added sbol");

      setTimeout(function() {
        var s = blastDB.query("TCTAAGGGCGAAG");
        
        s.on('data', function(data) {
          console.log("result:", data);
        });
        
        s.on('error', function(err) {
          console.error("stream error:", err);
        });
        
        s.on('end', function() {
        console.log("end of blast results");
        });
      }, 1000);
    });
  });
  
})

}, 1000);
