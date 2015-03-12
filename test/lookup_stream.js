/**
 * @file Test the pelias-model setter stream created by
 *    `../lib/master#stream()`. Reads points and corresponding expected values
 *    from `./lookup_stream.json`
 */

'use strict';

var through = require( 'through2' );
var lookup = require( '../lib/master' );
var peliasModel = require( 'pelias-model' );
var tape = require( 'tape' );

var lookupPoints = require( './lookup_points.json' );

/**
 * Test whether the setter stream sets values properly.
 */
tape( 'Test setter stream.', function ( test ){
  var expectedValues = lookupPoints.map( function ( testCase ){
    return testCase.expected;
  });

  var adminLevelNames = [
    'admin0', 'admin1', 'admin2', 'local_admin', 'locality', 'neighborhood'
  ];
  var lookupStream = lookup.stream();
  var testPipe = through.obj(
    function write( data, _, next ){
      var expected = expectedValues.shift();
      for( var prop in expected ){
        if( adminLevelNames.indexOf( prop ) !== -1 ){
          test.equal( data.getAdmin( prop ), expected[ prop ], prop + ' matches.' );
        }
      }

      if( expected.hasOwnProperty( 'alpha3' ) ){
        test.equal( data.getAlpha3(), expected.alpha3, 'alpha3 matches.' );
      }
      next();
    }, function end( done ){
      test.end();
      done();
    }
  );

  lookupStream.pipe( testPipe );
  lookupPoints.forEach( function ( testCase ){
    var doc = new peliasModel.Document( '_', 1 ).setCentroid( testCase.point );
    lookupStream.write( doc );
  });
  lookupStream.end();
});