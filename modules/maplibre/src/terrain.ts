// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {FilterContext, Layer} from '@deck.gl/core';
import type {Device, Framebuffer} from '@luma.gl/core';
import type {Map as MapLibreMap} from 'maplibre-gl';
import type {MapLibreRenderParameters} from './compatibility';
import type {MapLibreLayerProps} from './layer-utils';

/** Size of the world in Web Mercator common space */
const WORLD_SIZE = 512;

/** `[minX, minY, maxX, maxY]` in Web Mercator common space */
type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/** Draws the draped layers into a framebuffer, as the TerrainEffect hands it over */
type DrapeRenderer = (
  target: Framebuffer,
  bounds: Bounds,
  options?: {layerFilter?: (context: FilterContext) => boolean; devicePixelRatio?: number}
) => void;

/** What MapLibre passes to a custom layer's `renderToTerrainTile` */
export type TerrainTileInput = {
  tileID: {canonical: {x: number; y: number; z: number}; wrap: number};
  width: number;
  height: number;
};

/**
 * The terrain of a MapLibre map, in the shape that the TerrainEffect of `@deck.gl/extensions`
 * expects from the `externalTerrain` prop of a terrain layer
 */
export class MapLibreTerrain {
  /** Changes whenever the surface changes other than by camera movement */
  revision: number = 0;
  /** Changes when the draped layers change, so that MapLibre draws its terrain tiles again */
  tileRevision: number = 0;
  /** Called when layer groups gain or lose draped layers */
  onDrapedGroupsChange?: () => void;

  private map: MapLibreMap;
  private getDevice: () => Device | undefined;
  /** MapLibre's height map function, during the `prerender` call that deck.gl builds the height map in */
  private renderTerrainHeightMap: MapLibreRenderParameters['renderTerrainHeightMap'] | null = null;
  private drapeRenderer: DrapeRenderer | null = null;
  /** The `beforeId` of the layer groups that have draped layers */
  private drapedBeforeIds: Set<string | undefined> = new Set();
  /** The tile framebuffer of MapLibre, as a luma.gl framebuffer */
  private tileTarget: Framebuffer | null = null;

  constructor(map: MapLibreMap, getDevice: () => Device | undefined) {
    this.map = map;
    this.getDevice = getDevice;
    map.on('terrain', this._onTerrainChange);
    map.on('sourcedata', this._onSourceData);
  }

  /** Takes MapLibre's height map function from the `prerender` call of a layer group, or `null` after it */
  setRenderParameters(renderParameters: MapLibreRenderParameters | null): void {
    this.renderTerrainHeightMap = renderParameters?.renderTerrainHeightMap ?? null;
  }

  renderHeightMap(target: Framebuffer, bounds: Bounds): void {
    const [minX, minY, maxX, maxY] = bounds;
    this.renderTerrainHeightMap?.({
      texture: target.colorAttachments[0].texture.handle as WebGLTexture,
      width: target.width,
      height: target.height,
      bounds: [minX / WORLD_SIZE, 1 - maxY / WORLD_SIZE, maxX / WORLD_SIZE, 1 - minY / WORLD_SIZE]
    });
  }

  setDrapeRenderer(render: DrapeRenderer | null): void {
    this.drapeRenderer = render;
    if (!render) {
      this.drapedBeforeIds.clear();
    }
    this.map.once('render', () => {
      if (!render) {
        this.onDrapedGroupsChange?.();
      }
      this._redrawTiles();
    });
  }

  /**
   * Remembers which layer groups have draped layers, and redraws the terrain tiles once the
   * current frame is done
   */
  onDrapeChange(layers: Layer[]): void {
    const beforeIds = new Set(layers.map(layer => getRootLayer(layer).props.beforeId));
    const groupsChanged =
      beforeIds.size !== this.drapedBeforeIds.size ||
      [...beforeIds].some(beforeId => !this.drapedBeforeIds.has(beforeId));
    this.drapedBeforeIds = beforeIds;
    this.map.once('render', () => {
      if (groupsChanged) {
        this.onDrapedGroupsChange?.();
      }
      this._redrawTiles();
    });
  }

  /** Whether the layer group before `beforeId` has draped layers */
  hasDrapedLayers(beforeId?: string): boolean {
    return this.drapedBeforeIds.has(beforeId);
  }

  /** Draws the draped layers that pass `layerFilter` into the MapLibre terrain tile that is bound */
  drawTile(
    gl: WebGL2RenderingContext,
    {tileID, width, height}: TerrainTileInput,
    layerFilter: (context: FilterContext) => boolean
  ): void {
    const target = this.drapeRenderer && this._getTileTarget(gl, width, height);
    if (!target) {
      return;
    }
    const {x, y, z} = tileID.canonical;
    const tileSize = WORLD_SIZE / 2 ** z;
    const minX = (x + tileID.wrap * 2 ** z) * tileSize;
    const maxY = WORLD_SIZE - y * tileSize;
    const cssTileSize = WORLD_SIZE * 2 ** (this.map.getZoom() - z);
    this.drapeRenderer!(target, [minX, maxY - tileSize, minX + tileSize, maxY], {
      layerFilter,
      devicePixelRatio: width / cssTileSize
    });
  }

  finalize(): void {
    this.map.off('terrain', this._onTerrainChange);
    this.map.off('sourcedata', this._onSourceData);
    this.tileTarget?.destroy();
    this.tileTarget = null;
  }

  private _redrawTiles(): void {
    this.tileRevision++;
    this.map.triggerRepaint();
  }

  private _getTileTarget(
    gl: WebGL2RenderingContext,
    width: number,
    height: number
  ): Framebuffer | null {
    const handle = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const device = this.getDevice();
    if (!handle || !device) {
      return null;
    }
    const target = this.tileTarget;
    if (target?.handle === handle && target.width === width && target.height === height) {
      return target;
    }
    target?.destroy();
    this.tileTarget = device.createFramebuffer({
      id: 'maplibre-terrain-tile',
      handle,
      width,
      height
    });
    return this.tileTarget;
  }

  private _onTerrainChange = () => {
    this.revision++;
  };

  private _onSourceData = (event: {sourceId?: string}) => {
    if (event.sourceId && event.sourceId === this.map.getTerrain()?.source) {
      this.revision++;
    }
  };
}

function getRootLayer(layer: Layer): Layer<MapLibreLayerProps> {
  let root = layer;
  while (root.parent) {
    root = root.parent;
  }
  return root as Layer<MapLibreLayerProps>;
}
