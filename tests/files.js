var base = require('./common/base.js');
var fs = require('fs')
var tape = require('tape');

tape('files', function(t) {
    t.plan(7)
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
                    setTimeout(function() {
                        var s = blastDB.query("TCTAAGGGCGAAG")
                        s.on('data', function(data) {
                            switch(data.key) {
                            case "fasta":   t.deepEqual(data,JSON.parse(fs.readFileSync('sample_files/test.fasta.json')),"fasta matches"); break
                            case "genbank": data.index = 1
                                            t.deepEqual(data,JSON.parse(fs.readFileSync('sample_files/test.gb.json')), "genbank matches"); break
                            case "sbol":    t.deepEqual(data,JSON.parse(fs.readFileSync('sample_files/test.sbol.json')),  "sbol matches"); break
                            default: t.fail("weird data: " + data)
                            }
                        })
                        s.on('error', function(err) {
                            t.fail("stream error:", err)
                        })
                        s.on('end', function() {
                            t.pass("end of blast results")
                        })
                    }, 1000)
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
