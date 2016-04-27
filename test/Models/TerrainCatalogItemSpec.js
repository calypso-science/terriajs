'use strict';

/*global require*/
var CompositeCatalogItem = require('../../lib/Models/CompositeCatalogItem');
var TerrainCatalogItem = require('../../lib/Models/TerrainCatalogItem');
var Terria = require('../../lib/Models/Terria');
var when = require('terriajs-cesium/Source/ThirdParty/when');

describe('TerrainCatalogItem', function() {
    var terria;
    var item;

    beforeEach(function() {
        terria = new Terria({
            baseUrl: './'
        });
        item = new TerrainCatalogItem(terria);
    });

    it('sets terrainProvider on Cesium scene when enabled', function(done) {
        var fakeTerrainProvider = {};
        spyOn(item, '_createTerrainProvider').and.returnValue(fakeTerrainProvider);

        terria.cesium = {
            scene: {
                terrainProvider: undefined
            }
        };

        item.isEnabled = true;

        when(item.load()).then(function() {
            expect(terria.cesium.scene.terrainProvider).toBe(fakeTerrainProvider);
        }).then(done).otherwise(done.fail);
    });

    it('restores previous terrainProvider when disabled', function(done) {
        var fakeTerrainProvider = {};
        spyOn(item, '_createTerrainProvider').and.returnValue(fakeTerrainProvider);

        var originalTerrainProvider = {};
        terria.cesium = {
            scene: {
                terrainProvider: originalTerrainProvider
            }
        };

        item.isEnabled = true;

        when(item.load()).then(function() {
            expect(terria.cesium.scene.terrainProvider).toBe(fakeTerrainProvider);

            item.isEnabled = false;
            expect(terria.cesium.scene.terrainProvider).toBe(originalTerrainProvider);
        }).then(done).otherwise(done.fail);
    });

    it('hides other terrainProvider catalog items when enabled', function(done) {
        terria.cesium = {
            scene: {
                terrainProvider: undefined
            }
        };

        var enabledItem = new TerrainCatalogItem(terria);
        spyOn(enabledItem, '_createTerrainProvider').and.returnValue({});
        enabledItem.isEnabled = true;

        when(enabledItem.load()).then(function() {
            spyOn(item, '_createTerrainProvider').and.returnValue({});
            item.isEnabled = true;

            return when(item.load()).then(function() {
                expect(enabledItem.isShown).toBe(false);
            });
        }).then(done).otherwise(done.fail);
    });

    it('hides CompositeCatalogItem containing terrain when enabled', function(done) {
        terria.cesium = {
            scene: {
                terrainProvider: undefined
            }
        };

        var composite = new CompositeCatalogItem(terria);
        var enabledItem = new TerrainCatalogItem(terria);
        spyOn(enabledItem, '_createTerrainProvider').and.returnValue({});
        composite.add(enabledItem);

        composite.isEnabled = true;

        when(composite.load()).then(function() {
            spyOn(item, '_createTerrainProvider').and.returnValue({});
            item.isEnabled = true;

            return when(item.load()).then(function() {
                expect(composite.isShown).toBe(false);
            });
        }).then(done).otherwise(done.fail);
    });
});
