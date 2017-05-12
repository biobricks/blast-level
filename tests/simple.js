
var tmp = require('tmp');
var memdb = require('memdb');
var blastLevel = require('../index.js');

var db = memdb({valueEncoding: 'json'});

// create temporary dir for blast db storage
var tmpDir = tmp.dirSync({
  unsafeCleanup: true // auto-delete dir on close, even if it isn't empty
});

var blastDB = blastLevel(db, {
  seqProp: 'seq', // key in 'mydb' that stores the sequence data
  changeProp: 'updated',
  path: tmpDir.name, // directory to use for storing BLAST db
  rebuild: false, // rebuild the BLAST index when the db is opened
  listen: false, // listen for changes on level db and auto update BLAST db
//    debug: true
});

blastDB.on('error', function(err) {
  console.error("Error:", err);
});

function fail(err) {
  console.error(err);
  process.exit(1);
}


db.put('foo', {
  seq: "GATTACACATTACA",
  updated: 1
}, function(err) {
  if(err) fail(err);

  console.log("added foo");

  console.log("building blast index");

  blastDB.rebuild(function(err) {
    if(err) return console.error("Error:", err);
    
    db.put('bar', {
      seq: "CATCATCATATTACACATTACCATCATCAT",
      updated: 1
    }, function(err) {
      if(err) fail(err);
      
      console.log("added bar");
      
      
      console.log("rebuilding blast index");

      blastDB.rebuild(function(err) {
        if(err) return console.error("Error:", err);
        
        console.log("running blast query");
        
        blastDB.query("ATTACACATTAC", function(err, data) {
          if(err) return console.error("Error:", err);

          console.log("Got results:", data);
          
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