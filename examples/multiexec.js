#!/usr/bin/env node

var spawn = require('child_process').spawn;
var fs = require('fs');
var path = require('path');
var through = require('through2');

var settings = {
    binPath: "/home/juul/projects/bionet/blast/ncbi-blast-2.4.0+/bin"
};

var fastaFile = process.argv[2];
var queryFile = process.argv[3];

var ins = fs.createReadStream(fastaFile, {encoding: 'utf8'});

var buffer = '';

var entries = 0;
var matches = 0;

function loopWhile(cb) {
    var m = buffer.match(/^(>[^\n]+\n[^>]+)>/);
    if(!m) {
        return cb();
    }
    if(m.index !== 0) throw new Error("sequence offset encountered");
    var entry = m[1];
    buffer = buffer.substr(entry.length);
    entries++;

    query(entry, function(err, hitsfound) {
        if(err) return cb(err);
        if(hitsfound) matches++;
        loopWhile(cb);
    });
}

ins.pipe(through(function(data, enc, cb) {
    buffer += data.toString();
    loopWhile(function(err, end) {
        if(err) throw err;
        if(end) {
            console.log("Count:", matches);
            process.exit(0);
        }
        cb();
    });
}));

ins.on('end', function() {
    console.log("Count:", matches);
});



function query(seq, cb) {

    var cmd, args;

    cmd = path.join(settings.binPath, "blastn");
    args = ["-task", "blastn-short", "-subject", "-", "-query", queryFile];

    var blast = spawn(cmd, args);

    var stdoutClosed = false;
    var stderrClosed = false;
    var stderr = '';
    var str;
    var hitsfound = true;

    var buffer = '';

    blast.stdout.on('data', function(data) {
        str = data.toString();
        buffer += str;
        if(buffer.match(/no hits found/i)) {
            hitsfound = false;
        }
//        console.log("[blastn] " + str);
    });

    blast.stdout.on('close', function() {
        stdoutClosed = true;
        if(stderrClosed) {
            stderr = stderr ? new Error(stderr) : undefined;
            cb(stderr, hitsfound)
        }
    });

    blast.stderr.on('data', function(data) {
        stderr += data.toString();
    });    
    
    blast.stderr.on('close', function() {
        stderrClosed = true;
        if(stdoutClosed) {
            stderr = stderr ? new Error(stderr) : undefined;
            cb(stderr, hitsfound)
        }
    });
    
    blast.stdin.on('error', function(err) {
        console.error(err);
    });


    blast.stdin.end(seq, 'utf8');
}



/*

// with blast db. for some reason it only outputs 300 results
time ./blastn -task blastn-short -query ./examples/t7.fasta -db ../datasets/vector
real	0m0.182s

time cat ../../datasets/vector | ./blastn -task blastn-short -query ../../blast-level/examples/t7.fasta -subject -
real	0m0.442s

// running blastn once for each sequence, limited to 300 results
time ./multiexec.js ../../datasets/vector ./t7.fasta
real	0m5.251s

*/
