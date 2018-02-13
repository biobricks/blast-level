
Streaming BLAST indexes for leveldb databases. Automatically keep an up-to-date BLAST database for your leveldb sequence data and run streaming BLAST queries on the data.

WARNING: This module is not yet ready for production use. Proceed with caution.

# Dependencies

Ensure that you have a recent [NCBI BLAST+](https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastDocs&DOC_TYPE=Download) installed on your system. You need version `2.4.0` or later. 

You might be able to get away with:

```
sudo apt install ncbi-blast+
```

Otherwise, download the latest version from the above link and unzip the binaries into `/usr/local/bin`.

You can check if the correct BLAST+ binaries are installed using:

```
require('blast-level').check([binPath], [cb])
```

Where the optional binPath is your path to the BLAST tools. 


Install required node modules:

```
npm install
```

# Usage

```
var level = require('level');
var blastLevel = require('blast-level');

var db = level('mydb');
var blastDB = blastLevel(db, {
    type: 'nt', // this is a nucleotide database (as opposed to amino acids)
    seqProp: 'sequence', // property in 'mydb' that stores the sequence data
    changeProp: 'updated', // property in 'mydb' that stores last updated time
    path: 'my/blastdb/dir' // directory to use for storing BLAST databases
});

db.put('my_unique_id', {
  name: "Green Fluorescent Protein",
  sequence: "atgagcaaaggcgaagaactgtttaccggcgtggtgccgattctggtggaactggatgg",
  updated: new Date().getTime()
}, function(err) {
  if(err) return console.error(err);

  var stream = blastDB.query('caaaggcgaaactgtttacc');

  stream.on('data', function(data) {
    console.log("Result:", data);
  });

  stream.on('error', function(err) {
    console.log("Error:", err);
  });

  stream.on('end', function() {
    console.log("end of results")
  });
});

```

If you just want a plain callback for your query results, instead of a stream, you can provide a callback:

```
blastDB.blast('caaaggcgaaactgtttacc', function(err, data) {
  if(err) return console.error(err);
  if(!data) return console.log("end of results");

  console.log("result:", data);
});
```

# Modes

blastlevel can operate in two different modes: 

* blastdb: Fastest search but sequence changes trigger partial BLAST db rebuild
* direct: TODO not yet implemented. At least 2-3x slower than blastdb and puts more load on node.js + leveldb but no BLAST db is ever written to disk.

## blastdb

`blastdb` mode keeps a native BLAST database on disk. This is the fastest option. In this mode all existing data is kept in a primary BLAST database called `main` and all changes since `blast-level` was last rebuilt is kept in a separate `update` database. This is done because BLAST databases cannot be modified, so the entire database has to be re-written every time a change occurs. Instead of re-writing the entire database on every `.put` or `.del` only the added or changed databases 

 A main BLAST database is created from all sequence data in leveldb when the db is first opened and another database is kept that contains all changed sequences since the main database was rebuilt. The main database can be manually rebuilt by calling `.rebuild()` which should be done periodically, and it can be triggered automatically whenever the blastlevel database is opened by setting `rebuildOnOpen: true` (default false). If rebuildOnChange is set to true (default false) then a single BLAST db is kept containing all sequence data and the entire BLAST database is rebuilt every time sequence data is changed. See the Iplementation section for more details.

## direct

TODO: This mode has not yet been implemented.

`direct` mode does not keep a native BLAST database of the sequence data. Instead, all of the sequence data is streamed from leveldb and piped into the `blastn` command every time 

# API

## blastLevel(db, [opts] (constructor)

Constructor with all properties (defaults shown):

```
var blastDB = blastLevel(db, {
    mode: 'blastdb', // or 'direct' or 'streaming' (slow)
    type: 'nt', // 'nt' for nucleotide database. 'aa' for amino acid database
    seqProp: undefined, // property of leveldb value that contains the DNA/AA sequence or file path
    changeProp: undefined, // property of leveldb value that contains a value that will have changed if the sequence was changed, e.g. a timestamp for when the leveldb value was last updated or a hash of the sequence
    filterChanged: true, // filter seqs that have changed since last rebuild. only relevant in 'blastdb' mode when buildOnChange is false
    seqFormatted: false, // false if plaintext, true if FASTA, GenBank, SBOL, etc. 
    seqIsFile: false, // is seqProp a path to a file or array of files (or a function that returns a path to a file or array of files)? if false then seqProp should be a string or array of strings or a function returning either of those.
    seqFileBasePath: '.', // if seqIsFile, this is the base path
    seqFileEncoding: 'utf8', // string encoding of sequence files
    path: undefined, // path to use for storing BLAST database (blastdb mode only)
    listen: true, // listen for changes on level db instance and update BLAST db automatically
    rebuild: false, // rebuild the BLAST db on initialization (now)
    rebuildOnChange: false, // rebuild BLAST db whenever the leveldb is changed
    binPath: undefined, // path where BLAST+ binaries are located if not in PATH
    debug: false // turn debug output on or off
});
```

The option `seqProp` must be defined. Additionally `path` must be defined in 'blastdb' mode and `changeProp` must be defined in 'blastdb' mode unless rebuildOnChange is true or `filterChanged` is false.

`seqProp` can be a simple property name like 'sequence' or it can be a property path like 'foo.bar.baz.sequence'. It can also be a synchronous function that takes the value as its only argument and returns the sequence or file path. If the value is undefined for a leveldb value then that value will be skipped.

`changeProp` is like `seqProp` but must reference/return a value that changes whenever the sequence for that leveldb value changes. This could be a hash of the sequence but it could also simply be the time-date when the value was last updated.

If `seqFormatted` is true then [streaming-sequence-extractor](https://www.npmjs.com/package/streaming-sequence-extractor) is used to extract sequence information from FASTA, GenBank or SBOL data. The format is autodetected. This can be used with `seqIsFile` to consume sequences in a variety of formats based on file paths stored in the database.

## query(sequence, [opts], [cb])

Run a query on the BLAST database. If cb is not specified then a stream is returned with the results. If cb is specified then an array of results is handed to the callback.

## check([cb])

Check if the correct versions of all required NCBI BLAST+ binaries are installed. If no callback is specified then prints the results to stdout/stderr.

## .put(key, value, [opts], cb)

Same as a `.put` directly on the database but will wait for the index to finish updating before calling the callback.

## .del(key, value, [opts], cb)

Same as a `.del` directly on the database but will wait for the index to finish updating before calling the callback.

## .batch(key, value, [opts], cb)

Same as a `.batch` directly on the database but will wait for the index to finish updating before calling the callback. 

Note: Chained batch mode not yet implemented.

# Implementation

This module relies on the official [NCBI BLAST+ toolset](https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastDocs&DOC_TYPE=Download) being installed somewhere on your system. It is implemented as a wrapper rather than a native js module due to the somewhat complicated and lightly documented nature of the BLAST+ codebase ¯\_(ツ)_/¯

This module creates an actual BLAST database in BLAST database format by streaming the output of a leveldb database into the `makeblastdb` command line tool with metadata referencing the original leveldb entries. When a BLAST query is performed it is executed using the `blastn` or `blastp` command and the results are referenced to the original leveldb entries and streamed out.

Since none of the BLAST+ command line tools allow modifying a BLAST database (appending is sorta supported, see the Notes section) at first glance it seems that the entire BLAST database must be re-written every time the leveldb database changes in ways that modify the sequence data. However, this module implements a workaround. 

If `opts.rebuildOnChange` is false (the default) then two databases are kept. A 'main' database which is built the first time blast-level is initialized on a leveldb database containing any sequence data (or on first write), and an 'update' database that contains all new and changed sequences since last update which is rewritten on every change to the leveldb database (except deletions). Queries are performed on both databases as if they were a single database and results from the main database are ignored if the sequence was changed since it was added to the main database. A rebuild of the main database can be triggered by manually calling `.rebuild()` and should probably be scheduled to run periodically when server load is minimal. After a rebuild the main database will be up to date and the update database will disappear, only to re-appear as soon as an update is made. This implementation puts minimal load on the nodejs process and leveldb database since the rebuild of the update db is accomplished mostly by a blast command. If `opts.rebuildOnChange` is true then the main database will be rebuilt in its entirety on every change by streaming all leveldb sequences into a database anew. This is very rarely a good idea. The 'direct' mode accomplishes the same thing without keeping any on-disk BLAST database so only use this if you need to be able to run BLAST queries directly on the on-disk db as well.

## Gotchas 

When operating in blastdb mode with rebuildOnChange:false when a sequence is deleted or changed in leveldb the sequence is not deleted in the main blast database. If a query is run that results in a hit on a deleted or changed sequence the hit will be reported by blast but the hit will not be passed on to your callback. Since blast has a maximum number of hits that it reports for each query (usually 30) this can result in fewer than the expected number of hits being reported for no apparant reason or in extreme cases where all top 30 hits for a query have been deleted since last rebuild, no hits will be reported even though there may be hits on sequences with lower scores than the 30 deleted sequences. This is probably not fixable without changing the NCBI BLAST+ codebase. If you have a use case where this may become an issue you should consider using the 'direct' mode or manually triggering a rebuild more often.

# ToDo

## Next version

* switch away from level-changes so we can catch .on('batch')
* add useful debug output when opts.debug is used. maybe two levels of debug?
* add support for blastx, tblastx and tblastn
* write a whole bunch of unit tests

## Future

* implement direct mode (don't keep any on-filesystem blastdb)
* support megablast and maybe blastpgp
* write more unit tests
* use `makembindex` command to speed up queries?
* make it work with non-JSON value databases? 

# Design decisions and BLAST+ limitations 

This section discusses some of the early considerations that fed into the current design.

## Queries without a BLAST database

It is possible to run e.g. `blastn` without a BLAST database. The syntax is:

```
blastn -query /path/to/query/file -subject /path/to/subject/file
```

Both query and subject file can contain multiple FASTA sequences. 

You can use stdin as either the source of the query or the subject, but not both:

```
blastn -query /path/to/query/file -subject -
blastn -query - -subject /path/to/subject/file
```

If you need an input stream for both query and subject then you need to do something like:

```
./blastn -query - -subject <(nc -lU /tmp/mysocket)
```

and then to send the stream of data:

```
./program_outputting_fasta_sequences | nc -U /tmp/mysocket
```

This looks encouraging since it seems like we can use two input streams and one output stream and have a nice streaming blastn interface. Unfortunately because `blastn` sorts the output by best match first, it makes sense that it waits until the query is complete before outputting anything. It looks like this sorting cannot be turned off without altering the codebase, so you have no way of getting proper streaming result output other than to execute the blastn command once for each sequence in the database.

The file `examples/multiexec.js` implements the "call blastn once for each sequence"-strategy. This was compared to two other strategies: Using a normal blast database as input and using a stream of fasta sequences as input. The NCBI _vector_ database was used as a test set with T7 promoter sequence as the query and the "-task blastn-short" option set. Here's the results on my i5-2520M @ 2.5 GHz and an SSD (though the source files had been purposefully recently accessed such that they should be already be in RAM).

* blast database: 0.182 seconds
* fasta stream: 0.442 seconds
* multiexec: 12.354 seconds

The filesize of the vector blast database was 1.4 MB and the fasta version was 4.8 MB.

The blastn results were capped at 300 while multiexec yielded 901 results, but of course those were the 300 best results so cutting the multiexec results to 300 would not have been a fair comparison. I could not find any blastn option that would give more than 300 results (if this is posssible somehow, please let me know).

It is likely that the difference between multiexec and the other strategies would be much diminished when working with very long sequences, since the cost of executing a new instance of blastn is per sequence.

The multiexec strategy is too slow to seriously consider. The blast database strategy is obviously the fastest, but it comes at the cost of maintaining an up to date blast database of all sequences. Since it does not seem to be possible to modify an existing blast database (see next section) this requires either rebuilding the entire blast database every time any sequence is added, deleted or changed. Or doing something clever like keeping one blast database for all existing sequences and another for all changes since the last build, and then rebuilding the database e.g. every night at 4 am.

It's probably not a good idea to rebuild the entire blast database on each change, unless the database is rather small and changes are rare.

If the fasta stream strategy was used then it would only introduce a slowdown of about a factor 2.5, though granted that was with a fasta stream read from a file rather than from a database. This strategy seems like the winner since it'd be simple to pipe a leveldb read stream into blastn and be done with it. However, this would mean that a node.js process would need to traverse the entire leveldb database, reading the entire values, parsing the JSON and passing on only the sequence data. If queries end up taking multiple seconds then this could become a noticable burden on the server, leaving it tied up for long periods on each database update. 

## Modifying a BLAST database

While `makeblastdb` does not support modification of an existing BLAST database, forcing a complete rebuild of the database every time it changes, it does support concatenating existing databases, and it supports the creation of single-entry databases, thus it supports appending to a database in a crude way by first creating a new database with the sequence(s) to be appended, then concatenating the resulting database to the existing database. This isn't exactly an append operation since it writes an antire new database rather than appending to the existing database but it is still much faster than rebuilding from leveldb so I document it here in case someone finds it useful:

```
# Create a new BLAST database from the sequence(s) to be "appended":
cat seq_to_append1.fasta seq_to_append2.fasta | makeblastdb -dbtype nucl -title 'to_append' -out /tmp/to_append

# Concatenate the to_append database with the existing database
makeblastdb -dbtype nucl -title 'newdb' -in '/path/to/existing/db /tmp/to_append' -input_type blastdb -out /path/to/concatenated/db
```

## BLAST symbolic concat

It is possible to use `blastdb_aliastool` to create a BLAST database that simply references multiple existing databases, which makes it possible to query several databases at once as if they were a single database, however it is also possible to simply list multiple blast databases when running a query and they will be treated as a single database.

# Operating system support

This module has only been tested on debian/ubuntu systems. It will likely work on other *nix systems. 

# Copyright and license

Copyright 2016 - 2018 BioBricks Foundation

License: AGPLv3




