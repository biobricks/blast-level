
WARNING: This is not yet working. Don't believe this documentation. Come back later.

Streaming BLAST indexes for leveldb databases. Automatically keep an up-to-date BLAST database for your leveldb sequence data and run streaming BLAST queries on the data.


# Dependencies

Ensure that you have a recent [NCBI BLAST+](https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastDocs&DOC_TYPE=Download) installed on your system:

```
sudo apt-get install ncbi-blast+
```

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
    sequenceKey: 'sequence', // key in 'mydb' that stores the sequence data
    path: 'my/blastdb/dir' // directory to use for storing BLAST db
});

db.put('my_unique_id', {
  name: "Green Fluorescent Protein",
  sequence: "atgagcaaaggcgaagaactgtttaccggcgtggtgccgattctggtggaactggatgg..."
}, function(err) {
  if(err) return console.error(err);

  var stream = blastDB.blastStream('caaaggcgaaactgtttacc');

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

If your database entries have their DNA/RNA/AA sequence information stored under the key 'seq' then specify 'seq' as the sequence_key. 

If you just want a plain callback for your query results, instead of a stream, you can do:

```
blastDB.blast('caaaggcgaaactgtttacc', function(err, data) {
  if(err) return console.error(err);
  if(!data) return console.log("end of results");

  console.log("result:", data);
});
```

# Modes

blastlevel can operate in three different modes: 

* blastdb: fastest search but sequence changes trigger partial BLAST db rebuild
* direct: at least 2-3x slower than blastdb and puts more load on node.js + leveldb but no BLAST db is kept on disk at all. 
* streaming: ~70x slower than `blastdb` but results stream as they are found and are not sorted by blast. no index rebuild on sequence changes

In the `blastdb` and `direct` modes the output will be in the normal `blastn` format, meaning that a ranked list of the best matches is output to when the query is completed and nothing is output before completion. 

## blastdb

`blastdb` mode keeps a native BLAST database on disk. This is the fastest option. In this mode, assuming `opts.rebuildOnChange` is false, two BLAST databases are kept. A primary BLAST database is created from all sequence data in leveldb when the db is first opened and another database is kept that contains all changed sequences since the primary database was rebuilt. The primary database can be manually rebuilt by calling `.rebuild()` which could be done by a cron script, and it can be triggered automatically whenever the blastlevel database is opened by setting `rebuildOnOpen: true` (default false). If rebuildOnChange is set to true (default false) then a single BLAST db is kept containing all sequence data and the entire BLAST database is rebuilt every time sequence data is changed.

When operating in blastdb mode with rebuildOnChange:false (the default) when a sequence is deleted in leveldb the sequence is not deleted in the blast index. If a query is run that results in a hit on a deleted sequence the hit will be reported by blast but the hit will not be passed on to your callback. Since blast has a maximum number of hits that it reports for each query (usually 30) this can result in fewer than the expected number of hits being reported for no apparant reason or in extreme cases where all top 30 hits for a query have been deleted since last index rebuild no hits will be reported even though there may be hits on sequences with lower scores than the 30 deleted sequences. This is probably not fixable without changing the NCBI BLAST+ codebase. If you have a use case where this may become an issue you should consider using another mode.

## direct

`direct` mode does not keep a native BLAST database of the sequence data. Instead, all of the sequence data is streamed from leveldb and piped into the `blastn` command every time 

## streaming

In `streaming` mode `blastn` is called once for each sequence, which causes a significant performance hit, but each matching sequence result is streamed out as soon as it is matched in a streaming fashion. No ordering of results takes place in the `streaming` mode.


# API

## blastLevel(db, [opts] (constructor)

Constructor with all properties (defaults shown):

```
var blastDB = blastLevel(db, {
    mode: 'blastdb', // or 'direct' or 'streaming' (slow)
    seqProp: 'sequence', // property of db values that contain the DNA/AA sequence
    path: undefined, // path to use for storing BLAST database (blastdb mode only)
    listen: true, // listen for changes on db and update index automatically
    rebuild: false, // rebuild the BLAST db now
    rebuildOnChange: false, // rebuild main BLAST index whenever the db is changed
    keepUpdateIndex: true, // keep changes since last rebuild in separate BLAST db
    binPath: undefined, // path where BLAST+ binaries are located if not in PATH
    debug: false // turn debug output on or off
});
```

The options sequenceKey and path _must_ be defined. 

You can use blastDB just as you would use the leveldb database directly, but if auto_update is true then any change to the database that touches the sequence data will update the BLAST database to match the sequence data.

Note that if autoUpdate is true then operations like .put that trigger a change to the BLAST database will not call their callbacks until the BLAST update is completed. If you want to avoid this then either disable updateOnOpen or simply call the .put directly on the level database and trigger the update manually.



# Implementation

This module relies on the official [NCBI BLAST+ toolset](https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastDocs&DOC_TYPE=Download) being installed somewhere on your system. It is implemented as a wrapper rather than a native js module due to the somewhat complicated and lightly documented nature of the BLAST+ codebase ¯\_(ツ)_/¯

This module does not actually create a BLAST index, rather it creates an actual BLAST database in BLAST database format by streaming the output of a leveldb database into the `makeblastdb` command line tool with metadata referencing the original leveldb entries. When a BLAST query is performed it is executed using the `blastn` or `blastp` and the results are referenced to the original leveldb entries and streamed out.

Since none of the BLAST+ command line tools allow modifying a BLAST database (appending is sorta supported, see the Notes section) the entire BLAST database must be re-written every time the leveldb database changes in ways that modify the sequence data. 

# ToDo

* Use `makembindex` command to speed up queries.
* Support different tasks: blastn, blastn-short, megablast, dc-megablast
* unit tests
* move to on('change') instead of AbstracLevelDown
* implement direct mode
* implement .batch
* allow seqProp to be a function or 'foo.bar.baz'
* emit 'ready' event when initialization completes
* implement opts.rebuildOnOpen
* implement opts.rebuildOnUpdate
* Make it work with non-JSON value databases?

# Future

For a large enough dataset it may not be feasible to rebuild the entire BLAST database on each change. It should be fairly easy to implement an alternate strategy that accommodates both added, deleted and modified sequence data without constantly rewriting the entire database.

All new sequence data would be written to a separate database which would have to be rewritten on each change (or use the concat trick in the notes) but would be much smaller than the complete database. The query could then be run against both the existing and new database using `blastn -db 'db1 db2'` (blastdb_aliastool is not necessary) can be used to create an alias that links the two databases so they act as a single database.

For deleted data the existing module already throws away query results that do not match any leveldb entries.

For modified sequence data the modified sequence would simply be added as if it was new data and the identifier used to reference the BLAST database to leveldb entry would have to be changed for the leveldb entry so results for the old sequence would be ignored.

A new BLAST database could then be generated from scratch e.g. once every 24 hours.


# Dupe result protection

Since blastlevel keeps a primary database containing all of the existing sequences and a secondary database containing all sequences that have been added or modified since last BLAST db rebuild, if a sequence is changed then the new version will be added to the secondary BLAST db while the old version is still present in the primary BLAST db. 

When a BLAST query is executed then it is first run against the secondary BLAST db (if one exists) and a tally of all results is kept in memory as a list of IDs that had query results for their sequences. Then afterwards the query is run against the primary BLAST db and if any of the query results are for IDs that match the list of previous results then they are ignored.

# Design decisions and BLAST+ limitations 

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

This looks encouraging since it seems like we can use two input streams and one output stream and have a nice streaming blastn interface. Unfortunately because `blastn` sorts the output by best match first, it makes sense that it waits until the query is complete before outputting anything. It looks like this sorting cannot be turned off without altering the codebase, so you have no way of getting proper streaming result output other than to execute the blastn command once for each seqeuence in the database.

The file `examples/multiexec.js` implements the "call blastn once for each sequence"-strategy. This was compared to two other strategies: Using a normal blast database as input and using a stream of fasta sequences as input. The NCBI _vector_ database was used as a test set with T7 promoter sequence as the query and the "-task blastn-short" option set. Here's the results on my i5-2520M @ 2.5 GHz and an SSD (though the source files had been purposefully recently accessed such that they should be already be in RAM).

* blast database: 0.182 seconds
* fasta stream: 0.442 seconds
* multiexec: 12.354 seconds

The filesize of the vector blast database was 1.4 MB and the fasta version was 4.8 MB.

The blastn results were capped at 300 while multiexec yielded 901 results, but of course those were the 300 best results so cutting the multiexec results to 300 would not have been a fair comparison. I could not find any blastn option that would give more than 300 results (if this is posssible somehow, please let me know).

It is likely that the difference between multiexec and the other strategies would be much diminished when working with very long sequences, since the cost of executing a new instance of blastn is per sequence.

The multiexec strategy is too slow to seriously consider. The blast database strategy is obviously the fastest, but it comes at the cost of maintaining an up to date blast database of all sequences. Since it does not seem to be possible to modify an existing blast database (see next section) this requires either rebuilding the entire blast database every time any sequence is added, deleted or changed. Or doing something clever like keeping one blast database for all existing sequences and another for all changes since the last build, using the `blastdb_aliastool` to virtually combine them for the purpose of queries, and then rebuilding the database e.g. every night at 4 am.

It's probably not a good idea to rebuild this index on each change, unless the database is rather small and changes are rare.

If the fasta stream strategy was used then it would only introduce a slowdown of about a factor 2.5, though granted that was with a fasta stream read from a file rather than from a database. This strategy seems like the winner since it'd be simple to pipe a leveldb read stream into blastn and be done with it. However, this would mean that a node.js process would need to traverse the entire leveldb database, reading the entire values, parsing the JSON and passing on only the sequence data. If queries end up taking multiple seconds then this could become a noticable burden on the server. 

It might be preferably to deal with keeping actual blast databases and letting blastn do its thing indipendently and report back to node.js

## Modifying a BLAST database

While `makeblastdb` does not support modification of an existing BLAST database, forcing a complete rebuild of the database every time it changes, it does support concatenating existing databases, and it supports the creation of single-entry databases, thus it supports appending to a database in a crude way by first creating a new database with the sequence(s) to be appended, then concatenating the resulting database to the existing database. This isn't exactly an append operation since it writes an antire new database rather than appending to the existing database but it is still much faster than rebuilding from leveldb so I document it here in case someone finds it useful:

```
# Create a new BLAST database from the sequence(s) to be "appended":
cat seq_to_append1.fasta seq_to_append2.fasta | makeblastdb -dbtype nucl -title 'to_append' -out /tmp/to_append

# Concatenate the to_append database with the existing database
makeblastdb -dbtype nucl -title 'newdb' -in '/path/to/existing/db /tmp/to_append' -input_type blastdb -out /path/to/concatenated/db
```

## BLAST symbolic concat

It is possible to use the BLAST tools to create a BLAST database that simply references multiple existing databases, which makes it possible to query several databases at once as if they were a single database.

```
TODO 
```

# Operating system support

This module has only been tested on debian/ubunut linux. It will likely work on any *nix. The `direct` mode will definitely not work on windows since it depends on unix domain sockets and the `nc` utility.

# Copyright and license

Copyright 2016, 2017 BioBricks Foundation

License: AGPLv3




