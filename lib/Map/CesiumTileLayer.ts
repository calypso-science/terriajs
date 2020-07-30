import i18next from "i18next";
import L from "leaflet";
import { autorun, computed, observable } from "mobx";
import Cartesian2 from "terriajs-cesium/Source/Core/Cartesian2";
import Cartographic from "terriajs-cesium/Source/Core/Cartographic";
import CesiumCredit from "terriajs-cesium/Source/Core/Credit";
import defined from "terriajs-cesium/Source/Core/defined";
import CesiumEvent from "terriajs-cesium/Source/Core/Event";
import CesiumMath from "terriajs-cesium/Source/Core/Math";
import TileProviderError from "terriajs-cesium/Source/Core/TileProviderError";
import WebMercatorTilingScheme from "terriajs-cesium/Source/Core/WebMercatorTilingScheme";
import ImageryLayerFeatureInfo from "terriajs-cesium/Source/Scene/ImageryLayerFeatureInfo";
import ImageryProvider from "terriajs-cesium/Source/Scene/ImageryProvider";
import ImagerySplitDirection from "terriajs-cesium/Source/Scene/ImagerySplitDirection";
import isDefined from "../Core/isDefined";
import pollToPromise from "../Core/pollToPromise";
import getUrlForImageryTile from "./getUrlForImageryTile";

const FeatureDetection: FeatureDetection = require("terriajs-cesium/Source/Core/FeatureDetection")
  .default;

const swScratch = new Cartographic();
const neScratch = new Cartographic();
const swTileCoordinatesScratch = new Cartesian2();
const neTileCoordinatesScratch = new Cartesian2();

class Credit extends CesiumCredit {
  _shownInLeaflet?: boolean;
  _shownInLeafletLastUpdate?: boolean;
}

// As of Internet Explorer 11.483.15063.0 and Edge 40.15063.0.0 (EdgeHTML 15.15063) there is an apparent
// bug in both browsers where setting the `clip` CSS style on our Leaflet layers does not consistently
// cause the new clip to be applied.  The change shows up in the DOM inspector, but it is not reflected
// in the rendered view.  You can reproduce it by adding a layer and toggling it between left/both/right
// repeatedly, and you will quickly see it fail to update sometimes.  Unfortunateely my attempts to
// reproduce this in jsfiddle were unsuccessful, so presumably there is something unusual about our
// setup.  In any case, we do the usually-horrible thing here of detecting these browsers by their user
// agent, and then work around the bug by hiding the DOM element, forcing it to updated by asking for
// its bounding client rectangle, and then showing it again.  There's a bit of a performance hit to
// this, so we don't do it on other browsers that do not experience this bug.
const useClipUpdateWorkaround =
  FeatureDetection.isInternetExplorer() || FeatureDetection.isEdge();

export default class CesiumTileLayer extends L.TileLayer {
  readonly tileSize = 256;
  readonly errorEvent = new CesiumEvent();

  private initialized = false;
  private _usable = false;
  private _delayedUpdate?: number;
  private _zSubtract = 0;
  private _requestImageError?: TileProviderError;
  private _previousCredits: Credit[] = [];
  private _leafletUpdateInterval: number;

  @observable splitDirection = ImagerySplitDirection.NONE;
  @observable splitPosition: number = 0.5;

  constructor(
    readonly imageryProvider: ImageryProvider,
    options: L.TileLayerOptions = {}
  ) {
    super(<any>undefined, {
      ...options,
      updateInterval: defined((imageryProvider as any)._leafletUpdateInterval)
        ? (imageryProvider as any)._leafletUpdateInterval
        : 100
    });
    this.imageryProvider = imageryProvider;

    const disposeSplitterReaction = this._reactToSplitterChange();
    this.on("remove", disposeSplitterReaction);

    this._leafletUpdateInterval = defined(
      (imageryProvider as any)._leafletUpdateInterval
    )
      ? (imageryProvider as any)._leafletUpdateInterval
      : 100;
  }

  _reactToSplitterChange() {
    return autorun(() => {
      const container = this.getContainer();
      if (container === null) {
        return;
      }

      const { left: clipLeft, right: clipRight } = this._clipsForSplitter;
      let display = null;
      if (useClipUpdateWorkaround) {
        display = container.style.display;
        container.style.display = "none";
        container.getBoundingClientRect();
      }

      if (this.splitDirection === ImagerySplitDirection.LEFT) {
        container.style.clip = clipLeft;
      } else if (this.splitDirection === ImagerySplitDirection.RIGHT) {
        container.style.clip = clipRight;
      } else {
        container.style.clip = "auto";
      }

      if (useClipUpdateWorkaround) {
        container.style.display = display!;
      }
    });
  }

  @computed
  get _clipsForSplitter() {
    let clipLeft = "";
    let clipRight = "";
    let clipPositionWithinMap;
    let clipX;

    const map = this._map;
    const size = map.getSize();
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(size);
    clipPositionWithinMap = size.x * this.splitPosition;
    clipX = Math.round(nw.x + clipPositionWithinMap);
    clipLeft = "rect(" + [nw.y, clipX, se.y, nw.x].join("px,") + "px)";
    clipRight = "rect(" + [nw.y, se.x, se.y, clipX].join("px,") + "px)";

    return {
      left: clipLeft,
      right: clipRight,
      clipPositionWithinMap: clipPositionWithinMap,
      clipX: clipX
    };
  }

  _tileOnError(_done: unknown, _tile: unknown, _e: unknown) {
    // Do nothing, we'll handle tile errors separately.
  }

  createTile(coords: L.Coords, done: L.DoneCallback) {
    // Create a tile (Image) as normal.
    const tile = <HTMLImageElement>super.createTile(coords, done);

    // By default, Leaflet handles tile load errors by setting the Image to the error URL and raising
    // an error event.  We want to first raise an error event that optionally returns a promise and
    // retries after the promise resolves.

    const doRequest = (waitPromise?: any) => {
      if (waitPromise) {
        waitPromise
          .then(function() {
            doRequest();
          })
          .otherwise((e: unknown) => {
            // The tile has failed irrecoverably, so invoke Leaflet's standard
            // tile error handler.
            (<any>L.TileLayer).prototype._tileOnError.call(this, done, tile, e);
          });
        return;
      }

      // Setting src will trigger a new load or error event, even if the
      // new src is the same as the old one.
      const tileUrl = this.getTileUrl(coords);
      if (isDefined(tileUrl)) {
        tile.src = tileUrl;
      }
    };

    L.DomEvent.on(tile, "error", e => {
      const level = (<any>this)._getLevelFromZ(coords);
      const message = i18next.t("map.cesium.failedToObtain", {
        x: coords.x,
        y: coords.y,
        level: level
      });
      this._requestImageError = TileProviderError.handleError(
        <any>this._requestImageError,
        this.imageryProvider,
        <any>this.imageryProvider.errorEvent,
        message,
        coords.x,
        coords.y,
        level,
        doRequest,
        <any>e
      );
    });

    return tile;
  }

  getTileUrl(tilePoint: L.Coords): string {
    const level = this._getLevelFromZ(tilePoint);
    const errorTileUrl = this.options.errorTileUrl || "";
    if (level < 0) {
      return errorTileUrl;
    }

    return (
      getUrlForImageryTile(
        this.imageryProvider,
        tilePoint.x,
        tilePoint.y,
        level
      ) || errorTileUrl
    );
  }

  _getLevelFromZ(tilePoint: L.Coords) {
    return tilePoint.z - this._zSubtract;
  }

  _update() {
    if (!this.imageryProvider.ready) {
      if (!this._delayedUpdate) {
        this._delayedUpdate = <any>setTimeout(() => {
          this._delayedUpdate = undefined;
          this._update();
        }, this._leafletUpdateInterval);
      }
      return;
    }

    if (!this.initialized) {
      this.initialized = true;

      // Cancel the existing delayed update, if any.
      if (this._delayedUpdate) {
        clearTimeout(this._delayedUpdate);
        this._delayedUpdate = undefined;
      }

      this._delayedUpdate = <any>setTimeout(() => {
        this._delayedUpdate = undefined;

        // If we're no longer attached to a map, do nothing.
        if (!this._map) {
          return;
        }

        const tilingScheme = this.imageryProvider.tilingScheme;
        if (!(tilingScheme instanceof WebMercatorTilingScheme)) {
          this.errorEvent.raiseEvent(
            this,
            i18next.t("map.cesium.notWebMercatorTilingScheme")
          );
          return;
        }

        if (
          tilingScheme.getNumberOfXTilesAtLevel(0) === 2 &&
          tilingScheme.getNumberOfYTilesAtLevel(0) === 2
        ) {
          this._zSubtract = 1;
        } else if (
          tilingScheme.getNumberOfXTilesAtLevel(0) !== 1 ||
          tilingScheme.getNumberOfYTilesAtLevel(0) !== 1
        ) {
          this.errorEvent.raiseEvent(
            this,
            i18next.t("map.cesium.unusalTilingScheme")
          );
          return;
        }

        if (isDefined(this.imageryProvider.maximumLevel)) {
          this.options.maxNativeZoom = this.imageryProvider.maximumLevel;
        }

        if (defined(this.imageryProvider.minimumLevel)) {
          this.options.minNativeZoom = this.imageryProvider.minimumLevel;
        }

        if (isDefined(this.imageryProvider.credit)) {
          (<any>this._map).attributionControl.addAttribution(
            getCreditHtml(this.imageryProvider.credit)
          );
        }

        this._usable = true;

        this._update();
      }, this._leafletUpdateInterval);
    }

    if (this._usable) {
      (<any>L.TileLayer).prototype._update.apply(this, arguments);

      this._updateAttribution();
    }
  }

  _updateAttribution() {
    if (!this._usable || !isDefined(this.imageryProvider.getTileCredits)) {
      return;
    }

    for (let i = 0; i < this._previousCredits.length; ++i) {
      this._previousCredits[
        i
      ]._shownInLeafletLastUpdate = this._previousCredits[i]._shownInLeaflet;
      this._previousCredits[i]._shownInLeaflet = false;
    }

    const bounds = this._map.getBounds();
    const zoom = this._map.getZoom() - this._zSubtract;

    const tilingScheme = this.imageryProvider.tilingScheme;

    swScratch.longitude = Math.max(
      CesiumMath.negativePiToPi(CesiumMath.toRadians(bounds.getWest())),
      tilingScheme.rectangle.west
    );
    swScratch.latitude = Math.max(
      CesiumMath.toRadians(bounds.getSouth()),
      tilingScheme.rectangle.south
    );
    let sw = tilingScheme.positionToTileXY(
      swScratch,
      zoom,
      swTileCoordinatesScratch
    );
    if (!isDefined(sw)) {
      sw = swTileCoordinatesScratch;
      sw.x = 0;
      sw.y = tilingScheme.getNumberOfYTilesAtLevel(zoom) - 1;
    }

    neScratch.longitude = Math.min(
      CesiumMath.negativePiToPi(CesiumMath.toRadians(bounds.getEast())),
      tilingScheme.rectangle.east
    );
    neScratch.latitude = Math.min(
      CesiumMath.toRadians(bounds.getNorth()),
      tilingScheme.rectangle.north
    );
    let ne = tilingScheme.positionToTileXY(
      neScratch,
      zoom,
      neTileCoordinatesScratch
    );
    if (!isDefined(ne)) {
      ne = neTileCoordinatesScratch;
      ne.x = tilingScheme.getNumberOfXTilesAtLevel(zoom) - 1;
      ne.y = 0;
    }

    const nextCredits = [];

    for (let j = ne.y; j < sw.y; ++j) {
      for (let i = sw.x; i < ne.x; ++i) {
        const credits = <Credit[]>(
          this.imageryProvider.getTileCredits(i, j, zoom)
        );
        if (!defined(credits)) {
          continue;
        }

        for (let k = 0; k < credits.length; ++k) {
          const credit = credits[k];
          if (credit._shownInLeaflet) {
            continue;
          }

          credit._shownInLeaflet = true;
          nextCredits.push(credit);

          if (!credit._shownInLeafletLastUpdate) {
            (<any>this._map).attributionControl.addAttribution(
              getCreditHtml(credit)
            );
          }
        }
      }
    }

    // Remove attributions that applied last update but not this one.
    for (let i = 0; i < this._previousCredits.length; ++i) {
      if (!this._previousCredits[i]._shownInLeaflet) {
        (<any>this._map).attributionControl.removeAttribution(
          getCreditHtml(this._previousCredits[i])
        );
        this._previousCredits[i]._shownInLeafletLastUpdate = false;
      }
    }

    this._previousCredits = nextCredits;
  }

  getFeaturePickingCoords(
    map: L.Map,
    longitudeRadians: number,
    latitudeRadians: number
  ): Promise<{ x: number; y: number; level: number }> {
    const ll = new Cartographic(
      CesiumMath.negativePiToPi(longitudeRadians),
      latitudeRadians,
      0.0
    );
    const level = Math.round(map.getZoom());

    return pollToPromise(() => {
      return this.imageryProvider.ready;
    }).then(() => {
      const tilingScheme = this.imageryProvider.tilingScheme;
      const coords = tilingScheme.positionToTileXY(ll, level);
      return {
        x: coords.x,
        y: coords.y,
        level: level
      };
    });
  }

  pickFeatures(
    x: number,
    y: number,
    level: number,
    longitudeRadians: number,
    latitudeRadians: number
  ): Promise<ImageryLayerFeatureInfo> {
    return pollToPromise(() => {
      return this.imageryProvider.ready;
    }).then(() => {
      return this.imageryProvider.pickFeatures(
        x,
        y,
        level,
        longitudeRadians,
        latitudeRadians
      );
    });
  }

  onRemove(map: L.Map) {
    if (this._delayedUpdate) {
      clearTimeout(this._delayedUpdate);
      this._delayedUpdate = undefined;
    }

    for (let i = 0; i < this._previousCredits.length; ++i) {
      this._previousCredits[i]._shownInLeafletLastUpdate = false;
      this._previousCredits[i]._shownInLeaflet = false;
      (<any>map).attributionControl.removeAttribution(
        getCreditHtml(this._previousCredits[i])
      );
    }

    if (this._usable && defined(this.imageryProvider.credit)) {
      (<any>map).attributionControl.removeAttribution(
        getCreditHtml(this.imageryProvider.credit)
      );
    }

    L.TileLayer.prototype.onRemove.apply(this, [map]);

    // Check that this cancels tile requests when dragging the time slider and rapidly creating
    // and destroying layers.  If the image requests for previous times/layers are allowed to hang
    // around, they clog up the pipeline and it takes approximately forever for the browser
    // to get around to downloading the tiles that are actually needed.
    this._abortLoading();
    return this;
  }
}

function getCreditHtml(credit: Credit) {
  return credit.element.outerHTML;
}
