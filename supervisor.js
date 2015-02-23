/**
 * Warning: this is entirely a WIP proof-of-concept. Forks a `./worker`
 * process per admin level and loads one Quattroshapes layer into it.
 */

var childProcess = require( 'child_process' );
var peliasConfig = require( 'pelias-config' );
var path = require( 'path' );
var testPoints = require( './points.json' );

var quattroAdminLevels = [
  {
    name: 'admin1',
    path: 'adm1',
    props: [ 'qs_adm0', 'qs_adm0_a3', 'qs_a1' ]
  },
  {
    name: 'admin2',
    path: 'adm2',
    props: [ 'qs_a2' ]
  },
  {
    name: 'localadmin',
    path: 'localadmin',
    props: [ 'qs_la' ]
  },
  {
    name: 'locality',
    path: 'localities',
    props: [ 'qs_loc' ]
  },
  {
    name: 'neighborhood',
    path: 'neighborhoods',
    props: [ 'name' ]
  }
];

/**
 * Initialize all child processes, and pass an array of them to `cb()` when
 * they've all finished loading Quattroshapes.
 */
function initWorkers( cb ){
  var numLoadedLevels = 0;

  var config = peliasConfig.generate();
  var quattroPath = config.imports.quattroshapes.datapath;
  var workers = [];
  quattroAdminLevels.forEach( function ( lvlConfig ){
    var worker = childProcess.fork( './worker' );
    worker.on('message', function (){
      if( ++numLoadedLevels === quattroAdminLevels.length ){
        cb(workers);
      }
    });
    workers.push( worker );
    lvlConfig.path = path.join( quattroPath, 'qs_' + lvlConfig.path );
    worker.send( {
      type: 'load',
      config: lvlConfig
    });
  });
}

initWorkers( function (workers){
  // Used to store results from different processes while they get compiled
  // into a full admin hierarchy per `search()`.
  var responseMap = {};
  var searchId = 0;

  /**
   * Search the Quattroshapes layers in `workers` for the given node.
   */
  function search( node ){
    searchId++;
    responseMap[ searchId ] = {
      node: node,
      numResponses: 0
    };
    workers.forEach( function ( worker ){
      worker.send({
        type: 'search',
        id: searchId,
        coords: node.center_point
      });
    });
  }

  var numSearchesCompleted = 0;
  function searchCb( node ){
    console.log( JSON.stringify( node, undefined, 4 ) );
    if( ++numSearchesCompleted === testPoints.length ){
      // workers.forEach( function ( worker ){
      //   worker.kill();
      // });
    }
  }

  // Remap Quattro attribute names to more readable ones.
  var adminNameProps = {
    qs_adm0: 'admin0',
    qs_adm0_a3: 'alpha3',
    qs_a1: 'admin1',
    qs_a2: 'admin2',
    qs_la: 'localadmin',
    qs_loc: 'locality',
    name: 'neighborhood'
  };

  /**
   * Assemble responses from different child processes in `responseMap`.
   */
  workers.forEach( function ( worker ){
    worker.on( 'message', function ( resp ){
      var responses = responseMap[ resp.id ];
      for( var key in resp.results ){
        if( resp.results[ key ] !== undefined && resp.results[ key ] !== null ){
          responses.node[ adminNameProps[ key ] ] = resp.results[ key ];
        }
      }
      var hierarchyComplete = ++responses.numResponses === workers.length;
      if( hierarchyComplete ){
        delete responseMap[ resp.id ];
        searchCb( responses.node );
      }
    });
  });

  function searchAll(){
    console.log( 'performing search...' );
    testPoints.forEach( function ( point ){
      var node = {
        name: point.name,
        center_point: {
          lat: point.lat,
          lon: point.lon,
        }
      };
      search( node );
    });
  }

  searchAll();

  process.on( 'SIGUSR1', function() {
    console.log( 'reloading points...' );
    testPoints = require( './points.json' );
    searchAll();
  });

});
