var base = require('./common/base.js');
var tape = require('tape');

tape('simple_manual_rebuild', function(t) {
  t.plan(3)
  base(function(db, blastDB) {
    db.put('foo', {
      seq: "GATTACACATTACA",
      updated: 1
    }, function(err) {
      t.pass("added foo, building blast index")

      blastDB.rebuild(function(err) {
        if(err) t.fail("mysterious failure W: " + err)
        db.put('bar', {
          seq: "CATCATCATATTACACATTACCATCATCAT",
          updated: 1
        }, function(err) {
          t.pass("added bar, rebuilding blast index")
          blastDB.rebuild(function(err) {
            if(err) t.fail("mysterious failure X: " + err)

/*            
            blastDB.status(function(err, status) {
              if(err) t.fail("status failure: " + err);

              console.log(status);
*/
            blastDB.query("ATTACACATTAC", function(err, data) {

              if(err) t.fail("mysterious failure Y: " + err)
              for (var i in data) {
                delete data[i].hsps
              }
              t.deepEqual(data,[{
                key: 'foo',
                value: { seq: 'GATTACACATTACA', updated: 1 },
                index: undefined
              },{
                key: 'bar',
                value: { seq: 'CATCATCATATTACACATTACCATCATCAT', updated: 1 },
                index: undefined
              }],"query data as expected")
            }, function(err) {
              if(err) t.fail("mysterious failure Z: " + err)
              t.pass("end of results")
            })
          })
//          })
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

