/**
 * Warning: this is entirely a WIP proof-of-concept. A worker process designed
 * to load one Quattro layer into memory.
 */

var loadShapefile = require( './load_shapefile' );

var adminLookup;
var name;

function messageHandler( msg ){
  if( msg.type === 'load' ){
    name = msg.config.name;
    console.log( 'loading', name );
    loadShapefile.load( msg.config, function ( lookup ){
      adminLookup = lookup;
      console.log( 'loaded', name );
      process.send( 'loaded' );
    });
  }
  else if( msg.type === 'search' ){
    var results = adminLookup.search( msg.coords.lon, msg.coords.lat );
    if( results !== undefined ){
      results = results.properties;
    }
    else {
      results = {};
    }
    process.send({
      name: name,
      id: msg.id,
      results: results
    });
  }
}

process.on( 'message', messageHandler );