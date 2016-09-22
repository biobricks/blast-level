
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

# API

Constructor with all properties (defaults shown):

```
var blastDB = blastLevel(db, {
  sequenceKey: undefined, // key in db that stores the sequence data
  path: undefined, // directory to use for storing BLAST db
  autoUpdate: true, // rebuild blast database when db is changed
  updateOnOpen: true, // rebuild blast database when db is opened
  binPath: '', // if BLAST+ commands are not in PATH specify bin directory here
  debug: false // enable debug output
});
```

The options sequenceKey and path _must_ be defined. 

You can use blastDB just as you would use the leveldb database directly, but if auto_update is true then any change to the database that touches the sequence data will update the BLAST database to match the sequence data.

Note that if autoUpdate is true then operations like .put that trigger a change to the BLAST database will not call their callbacks until the BLAST update is completed. If you want to avoid this then either disable updateOnOpen or simply call the .put directly on the level database and trigger the update manually.

## blastStream(query)

ToDo writeme

## blast(query, callback)

ToDo writeme

## update()

Update the BLAST database based on the leveldb database. This actually writes an entirely new BLAST database, then seemlessly switches blastLevel over to the new database and deletes the old one.

# Implementation

This module relies on the official [NCBI BLAST+ toolset](https://blast.ncbi.nlm.nih.gov/Blast.cgi?PAGE_TYPE=BlastDocs&DOC_TYPE=Download) being installed somewhere on your system. It is implemented as a wrapper rather than a native js module due to the somewhat complicated and lightly documented nature of the BLAST+ codebase ¯\_(ツ)_/¯

This module does not actually create a BLAST index, rather it creates an actual BLAST database in BLAST database format by streaming the output of a leveldb database into the `makeblastdb` command line tool with metadata referencing the original leveldb entries. When a BLAST query is performed it is executed using the `blastn` or `blastp` and the results are referenced to the original leveldb entries and streamed out.

Since none of the BLAST+ command line tools allow modifying a BLAST database (appending is sorta supported, see the Notes section) the entire BLAST database must be re-written every time the leveldb database changes in ways that modify the sequence data. 

# ToDo

## Critical

* .batch needs to intercept put requests

## Nice to have

* opts.rebuildOnOpen
* opts.rebuildOnUpdate
* opts.threadsPerQuery
* Add an option for automatic triggering of BLAST database updates without causing the callbacks to wait for the BLAST database update to complete.

# Future

For a large enough dataset it may not be feasible to rebuild the entire BLAST database on each change. It should be fairly easy to implement an alternate strategy that accommodates both added, deleted and modified sequence data without constantly rewriting the entire database.

All new sequence data would be written to a separate database which would have to be rewritten on each change (or use the concat trick in the notes) but would be much smaller than the complete database. The query could then be run against both the existing and new database or the BLAST+ tool `blastdb_aliastool` can be used to create an alias that links the two databases so they act as a single database.

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

While makeblastdb does not support modification of an existing BLAST database, forcing a complete rebuild of the database every time it changes, it does support concatenating existing databases, and it supports the creation of single-entry databases, thus it supports appending to a database in a crude way by first creating a new database with the sequence(s) to be appended, then concatenating the resulting database to the existing database. This isn't exactly an append operation since it writes an antire new database rather than appending to the existing database but it is still likely faster than rebuilding from leveldb so I document it here in case someone finds it useful:

```
# Create a new BLAST database from the sequence(s) to be "appended":
cat seq_to_append1.fasta seq_to_append2.fasta | makeblastdb -dbtype nucl -title 'to_append' -out /tmp/to_append

# Concatenate the to_append database with the existing database
makeblastdb -dbtype nucl -title 'newdb' -in '/path/to/existing/db /tmp/to_append' -input_type blastdb -out /path/to/concatenated/db
```

# Copyright and license

Copyright 2016 BioBricks Foundation

License: AGPLv3




