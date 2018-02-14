var base = require('./common/base.js');
var tape = require('tape');

var seqs = ["GATTACACATTACA", "CATCATCATATTACACATTACCATCATCAT"];

tape('status', function(t) {
  t.plan(6)

  base(function(db, blastDB) {

    blastDB.put('foo', {
      seq: seqs[0],
      updated: 1
    }, function(err) {
      t.pass("added foo, not rebuilding")

        blastDB.put('bar', {
          seq: seqs[1],
          updated: 1
        }, function(err) {
          t.pass("added bar, rebuilding blast index")

            blastDB.query("ATTACACATTAC", function(err, metadata, s) {
              if(err) t.fail("mysterious failure Y: " + err)

              t.equals(metadata.hits, seqs.length, "number of results check");

              var i = 0;

              s.on('data', function(data) {
                if(data.value.seq !== seqs[seqs.length - 1 - i++]) t.fail("Returned wrong first result:" + data.value);
                t.pass("correct sequence " + i);
              });

              s.on('error', function(err) {
                t.fail("stream error:", err)
              })

              s.on('end', function() {
                t.pass("end of blast results")
              })
            });
          })

    })
  },{
    seqProp: 'seq', // key in 'mydb' that stores the sequence data
    changeProp: 'updated',
    rebuild: false, // rebuild the BLAST index when the db is opened
    listen: false, // listen for changes on level db and auto update BLAST db
  })
})

