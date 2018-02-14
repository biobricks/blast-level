var base = require('./common/base.js');
var tape = require('tape');

tape('status', function(t) {
  t.plan(3)

  base(function(db, blastDB) {

    blastDB.put('foo', {
      seq: "GATTACACATTACA",
      updated: 1
    }, function(err) {
      t.pass("added foo, not rebuilding")

      blastDB.status(function(err, status) {
        if(err) t.fail("failed during blastDB.status call 1: " + err);

//        console.log("Got status 1:", JSON.stringify(status, null, 2));
      
        blastDB.put('bar', {
          seq: "CATCATCATATTACACATTACCATCATCAT",
          updated: 1
        }, function(err) {
          t.pass("added bar, rebuilding blast index")

          blastDB.status(function(err, status) {
            if(err) t.fail("failed during blastDB.status call 2: " + err);
            
//            console.log("Got status 2:", JSON.stringify(status, null, 2));

            blastDB.query("ATTACACATTAC", {output: 'array'}, function(err, metadata, data) {

              if(err) t.fail("mysterious failure Y: " + err)

              for (var i in data) {
                delete data[i].hsps
              }

              data.sort(function(a, b) {
                if(a < b) return -1;
                if(b > a) return 1;
                return 0;
              });

              t.deepEqual(data, [{
                key: 'bar',
                value: { seq: 'CATCATCATATTACACATTACCATCATCAT', updated: 1 },
                index: undefined
              }, {
                key: 'foo',
                value: { seq: 'GATTACACATTACA', updated: 1 },
                index: undefined
              }],"query data as expected")
            }, function(err) {
              if(err) t.fail("mysterious failure Z: " + err)
              t.pass("end of results")
            })
          })
        })
      })
    })
  },{
    seqProp: 'seq', // key in 'mydb' that stores the sequence data
    changeProp: 'updated',
    rebuild: false, // rebuild the BLAST index when the db is opened
    listen: false, // listen for changes on level db and auto update BLAST db
  })
})

