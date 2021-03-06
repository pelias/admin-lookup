/**
 * @file In order to load huge volumes of polygon data into memory without
 * breaking Node (due to its low heap-size limits), the package forks a
 * worker process per polygon layer/shapefile. This module contains
 * functions for initializing them and searching them.
 */

'use strict';

var childProcess = require( 'child_process' );
var peliasConfig = require( 'pelias-config' );
var path = require( 'path' );
var through = require( 'through2' );
var logger = require( 'pelias-logger' ).get( 'admin-lookup:master' );
var microtime = require( 'microtime' );

var requireDir = require( 'require-dir' );
var stateAbbreviations = requireDir( '../state_abbreviations' );

/**
 * For every desired administrative layer, specifies its name, the partial path
 * of the corresponding Quattroshapes file, and the properties to extract from
 * it.
 */
var quattroAdminLevels = [
  {
    name: 'admin1',
    path: 'adm1',
    props: [ 'qs_adm0', 'qs_adm0_a3', 'qs_a1' ]
  },
  {
    name: 'admin2',
    path: 'adm2',
    props: [ 'qs_a2', 'qs_a2_alt' ]
  },
  {
    name: 'local_admin',
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
    props: [
      'name', 'name_adm0', 'name_adm1', 'name_adm2', 'name_lau', 'name_local'
    ]
  }
];

/**
 * Keep track of workers initialized with `initWorkers()`, to kill them and
 * exit when the consumer tries to create the admin-lookup twice.
 */
var existingWorkers = null;

/**
 * Fork a `./worker.js` per layer in `quattroAdminLevels`, load the
 * corresponding polygons into it, and create functions for searching
 * it/shutting it down.
 *
 * @param {function(workers)} cb The callback that will receive a
 *    `ChildProcess array`.
 */
function initWorkers( cb ){
  if( existingWorkers !== null ){
    var errMsg = 'The admin-lookup should only be initialized once since it ' +
      'consumes massive amounts of memory!';

    logger.error( 'Killing workers.' );
    existingWorkers.forEach( function ( worker ){
      worker.kill();
    });
    throw errMsg;
  }

  existingWorkers = [];
  logger.info( 'Initializing workers.' );

  var numLoadedLevels = 0;

  var config = peliasConfig.generate();
  var quattroPath = config.imports.quattroshapes.datapath;
  var workers = [];
  quattroAdminLevels.forEach( function ( lvlConfig ){
    var worker = childProcess.fork( path.join( __dirname, 'worker' ) );
    existingWorkers.push( worker );
    worker.on('message', function (){
      if( ++numLoadedLevels === quattroAdminLevels.length ){
        logger.info( 'Finished initializing workers.' );
        cb( workers );
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

/**
 * Create functions for searching and deinitializing a set of layers workers,
 * as created with `initWorkers()`. Returns an object containing.
 *
 * @param {array of ChildProcess} workers The workers created by `initWorkers()`.
 * @return {object} An object containing functions for manipulating the
 *    admin-layer processes in `workers`. Contains the following keys:
 *
 *    search: A function that accepts a `{ lat:, lon: }` object, and a callback.
 *        It'll pass the result of intersecting said lat/lon against each
 *        admin layer to the callback as an object.
 *    end: A function to deinitialize all forked processes. Must be called
 *        once you're finshed with them to prevent hangs.
 */
function createLookup( workers ){
  // Used to pool responses from different workers per search query, and stores
  // the callback corresponding to each search.
  var responseMap = {};

  workers.forEach( function ( worker ){
    worker.on( 'message', function ( resp ){
      var responses = responseMap[ resp.id ];
      responses[ resp.name ] = resp.results;

      var hierarchyComplete = ++responses.numResponses === workers.length;
      if( hierarchyComplete ){
        completeSearch( resp.id );
      }
    });
  });

  // Once all responses for search `id` have been pooled, assemble the
  // administrative names object and pass it to that search's callback.
  function completeSearch( id ){
    var resps = responseMap[ id ];
    delete responseMap[ id ];

    var result = {};
    result.alpha3 = resps.admin1.qs_adm0_a3;
    result.admin0 = resps.admin1.qs_adm0;
    result.admin1 = resps.admin1.qs_a1;
    result.admin2 = resps.admin2.qs_a2_alt || resps.admin2.qs_a2 || resps.neighborhood.name_adm2;
    result.local_admin = resps.local_admin.qs_la;
    result.locality = resps.locality.qs_loc;
    result.neighborhood = resps.neighborhood.name;

    /**
     * If the record has an alpha-3 value and a state (admin1) name, and if the
     * corresponding country has state-name abbreviations, find the
     * abbreviation for the state name and assign it to the `admin1_abbr`
     * property.
     */
    if( typeof result.alpha3 === 'string' && typeof result.admin1 === 'string' ){
      var alpha3 = result.alpha3.toLowerCase();
      if( alpha3 in stateAbbreviations ){
        for( var stateName in stateAbbreviations[ alpha3 ] ){
          if( stateName.toLowerCase() === result.admin1.toLowerCase() ){
            result.admin1_abbr = stateAbbreviations[ alpha3 ][ stateName ];
            break;
          }
        }
      }
    }

    resps.cb( result );
  }

  // Used to disambiguate child responses if `search()`es are occuring in
  // parallel.
  var searchId = 0;

  function search( latLon, cb ){
    searchId++;
    responseMap[ searchId ] = {
      numResponses: 0,
      cb: cb
    };
    workers.forEach( function ( worker ){
      worker.send({
        type: 'search',
        id: searchId,
        coords: latLon
      });
    });
  }

  function end(){
    workers.forEach( function ( worker ){
      worker.kill();
    });
  }

  return {
    search: search,
    end: end
  };
}

/**
 * Create a streaming wrapper for the `search` and `end` functions returned by
 * `createLookup()`. Note that, while it appears to execute synchronously and
 * immediately returns the stream, the stream won't let any records through
 * until `initWorkers()` completes.
 *
 * @return {Transform stream} A stream that expects `pelias-model` `Document`
 *    objects, intersects each of them against the admin layers, and adds
 *    various attributes using their `set*()` setter methods.
 */
function createLookupStreamSync(){
  var adminLevelNames = [
    'admin0', 'admin1', 'admin2', 'local_admin', 'locality', 'neighborhood'
  ];

  var stats = {
    failures: {
      alpha3: 0,
      population: 0,
      popularity: 0,
      admin0: 0,
      admin1: 0,
      admin1_abbr: 0,
      admin2: 0,
      local_admin: 0,
      locality: 0,
      neighborhood: 0
    },
    timeTaken: 0
  };

  var loggerInterval;

  // Will be populated with `createLookup()` once `initWorkers()` returns.
  var lookup;

  function write( model, _, next ){
    var adminLookupConfig = model.getMeta( 'adminLookup' ) || {};
    var dontSet = adminLookupConfig.dontSet || [];

    function execSearch(){
      var startTime = microtime.nowDouble();
      lookup.search( model.getCentroid(), function searchCb( results ){
        if( dontSet.indexOf( 'alpha3' ) === -1 && model.getAlpha3() === undefined ){
          try {
            model.setAlpha3( results.alpha3 );
          }
          catch( ex ){
            stats.failures.alpha3++;
          }
        }

        if( dontSet.indexOf( 'admin1_abbr' ) === -1 &&
            model.getAdmin( 'admin1_abbr' ) === undefined ){
          try {
            model.setAdmin( 'admin1_abbr', results.admin1_abbr );
          }
          catch ( ex ) {
            stats.failures.admin1_abbr++;
          }
        }

        adminLevelNames.forEach( function ( name ){
          if( dontSet.indexOf( name ) === -1 && model.getAdmin( name ) === undefined ){
              try {
              model.setAdmin( name, results[ name ] );
            }
            catch ( ex ) {
              stats.failures[ name ]++;
            }
          }
        });
        stats.timeTaken += microtime.nowDouble() - startTime;
        next( null, model );
      });
    }

    if( lookup === undefined ){
      initWorkers( function ( workers ){
        loggerInterval = setInterval( function (  ){
          logger.verbose( stats );
        }, 10000);
        lookup = createLookup( workers );
        execSearch();
      });
    }
    else {
      execSearch();
    }
  }

  function end( done ){
    clearInterval( loggerInterval );
    lookup.end();
    done();
  }

  return through.obj( write, end );
}

module.exports = {
  initWorkers: initWorkers,
  lookup: function( cb ){
    initWorkers( function ( workers ){
      cb( createLookup( workers ) );
    });
  },
  stream: createLookupStreamSync
};
