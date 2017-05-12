var base = require('base');
var tape = require('tape');

tape('simple', function(t) {
    t.plan(3)
    base(function(data) {
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
    },{
        seqProp: 'seq', // key in 'mydb' that stores the sequence data
        changeProp: 'updated',
        rebuild: false, // rebuild the BLAST index when the db is opened
        listen: false, // listen for changes on level db and auto update BLAST db
    },t)
})
