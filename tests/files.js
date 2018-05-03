var base = require('./common/base.js');
var fs = require('fs')
var tape = require('tape');

tape('files', function(t) {
  t.plan(18)
  base(function(db, blastDB) {
    db.put('fasta', {
      seqFile: "test.fasta",
      updated: 1
    }, function(err) {
      if(err) t.fail("mysterious failure A: " + err)
      t.pass("added fasta, building blast index")
      db.put('genbank', {
        seqFile: "test.gb",
        updated: 1
      }, function(err) {
        if(err) t.fail("mysterious failure B: " + err)
        t.pass("added genbank")
        db.put('sbol', {
          seqFile: "test.sbol",
          updated: 1
        }, function(err) {
          if(err) t.fail("mysterious failure C: " + err)
          t.pass("added sbol")

          // wait for database to build before running query
          setTimeout(function() {
            var s = blastDB.query("TCTAAGGGCGAAG")
            s.on('data', function(data) {
              switch(data.key) {
              case "fasta":  
                t.equal(data.hsps.length, 1);
                t.equal(data.hsps[0].hseq, "TCTAAGGGCGAAG");
                break
              case "genbank": 
                t.equal(data.hsps.length, 3);
                t.equal(data.hsps[0].hseq, "CTAAGGG");
                t.equal(data.hsps[1].hseq, "AGGGCGA");
                t.equal(data.hsps[2].hseq, "AGGGCGA");
                break
              case "sbol":
                t.equal(data.hsps.length, 3);
                t.equal(data.hsps[0].hseq, "TCTAAGGGCGAAG");
                t.equal(data.hsps[1].hseq, "AGGGCGAAG");
                t.equal(data.hsps[2].hseq, "GGCGAAG");
                break;
              default: t.fail("weird data: " + data)
              }
            })
            s.on('error', function(err) {
              t.fail("stream error:", err)
            })
            s.on('end', function() {
              t.pass("end of blast results")
            })
          }, 2000)
        })
      })
    })
  },{
    seqProp: 'seqFile', // key in 'mydb' that stores the sequence data
    seqIsFile: true,
    seqFileBasePath: "sample_files",
    seqFormatted: true,
    changeProp: 'updated',
    rebuildOnChange: false,
    listen: true // listen for changes on level db and auto update BLAST db
  })
})
