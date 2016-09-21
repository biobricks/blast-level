
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

# Notes

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




