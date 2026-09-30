// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_flatten as flatten} from '@deck.gl/core';
import {_TerrainExtension as TerrainExtension} from '@deck.gl/extensions';
import {BitmapLayer, PathLayer, ScatterplotLayer} from '@deck.gl/layers';
import {MapLibreOverlay} from '@deck.gl/maplibre';
import {device} from '@deck.gl/test-utils';
import {Map as MapLibreV4Map} from 'maplibre-gl-v4';
import {Map as MapLibreV5Map} from 'maplibre-gl-v5';
import {Map as MapLibreV6Map} from 'maplibre-gl-v6';
import {test, expect, vi} from 'vitest';

import {getMapLibreElevation} from '../../../modules/maplibre/src/compatibility';

import type {Map as MapLibreMap} from 'maplibre-gl-v6';

const webglTest = device.type === 'webgl' ? test : test.skip;

function waitForRender(condition: () => boolean, update?: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let animationFrame = 0;
    let finished = false;
    const timeout = setTimeout(() => {
      finished = true;
      cancelAnimationFrame(animationFrame);
      reject(new Error('MapLibre render timed out'));
    }, 5000);
    const check = () => {
      if (finished) {
        return;
      }
      if (condition()) {
        finished = true;
        clearTimeout(timeout);
        resolve();
      } else {
        animationFrame = requestAnimationFrame(check);
      }
    };
    update?.();
    check();
  });
}

function readCenterPixel(gl: WebGL2RenderingContext): number[] {
  const pixel = new Uint8Array(4);
  gl.readPixels(
    Math.floor(gl.drawingBufferWidth / 2),
    Math.floor(gl.drawingBufferHeight / 2),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel
  );
  return Array.from(pixel);
}

/** Returns the URL of a raster-dem tile of constant height, in the Mapbox Terrain-RGB encoding */
async function createDemTileURL(elevation: number): Promise<string> {
  const value = Math.round((elevation + 10000) * 10);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  context.fillStyle = `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  return URL.createObjectURL(blob!);
}

// Aliases in modules/maplibre/package.json pin the earliest supported release of each major.
// Add an alias, import, and entry here when supporting a new major.
const MAPLIBRE_VERSIONS = [
  {version: '4.5.1', MapClass: MapLibreV4Map},
  {version: '5.0.0', MapClass: MapLibreV5Map},
  {version: '6.0.0', MapClass: MapLibreV6Map}
];

test('MapLibreOverlay overlaid uses only public MapLibre APIs', () => {
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientWidth: {value: 800},
    clientHeight: {value: 600}
  });
  const map = {
    get transform(): never {
      throw new Error('MapLibre private API accessed: transform');
    },
    get painter(): never {
      throw new Error('MapLibre private API accessed: painter');
    },
    get style(): never {
      throw new Error('MapLibre private API accessed: style');
    },
    getCenter: () => ({lng: -122.45, lat: 37.78}),
    getZoom: () => 14,
    getBearing: () => 0,
    getPitch: () => 0,
    getPadding: () => ({left: 0, right: 0, top: 0, bottom: 0}),
    getRenderWorldCopies: () => true,
    getCenterElevation: () => 125,
    getProjection: () => {
      throw new Error('Style is not loaded');
    },
    getContainer: () => container,
    on() {},
    off() {}
  } as unknown as Parameters<MapLibreOverlay['onAdd']>[0];
  const overlay = new MapLibreOverlay({device, layers: []});

  overlay.onAdd(map);

  expect(overlay._deck).toBeTruthy();
  expect(overlay._deck!.props.viewState.position).toEqual([0, 0, 125]);
  expect(overlay._deck!.props.views.id).toBe('maplibre');

  overlay.onRemove(map);
  expect(overlay._deck).toBeFalsy();
});

for (const {version, MapClass} of MAPLIBRE_VERSIONS) {
  webglTest(`MapLibreOverlay renders with MapLibre ${version}`, async () => {
    const container = document.createElement('div');
    Object.assign(container.style, {width: '400px', height: '300px'});
    document.body.append(container);

    const map = new MapClass({
      container,
      style: {
        version: 8,
        sources: {},
        layers: [{id: 'labels', type: 'background'}]
      },
      center: [-122.45, 37.78],
      zoom: 14,
      attributionControl: false
    }) as unknown as MapLibreMap;
    await new Promise<void>(resolve => map.once('load', () => resolve()));

    for (const interleaved of [false, true]) {
      map.jumpTo({center: [-122.45, 37.78], zoom: 14});
      let centerPixel: number[] = [];
      const image = new ImageData(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
      const bounds: [number, number, number, number] = [-122.46, 37.77, -122.44, 37.79];
      const overlay = new MapLibreOverlay({
        interleaved,
        device: interleaved ? undefined : device,
        onAfterRender: ({gl}) => {
          if (!gl || interleaved) {
            return;
          }
          const renderedPixel = readCenterPixel(gl);
          if (renderedPixel[0] === 255) {
            centerPixel = renderedPixel;
          }
        },
        layers: [
          new BitmapLayer({id: 'under-labels', image, bounds, beforeId: 'labels'}),
          new BitmapLayer({id: 'above-labels', image, bounds})
        ]
      });

      map.addControl(overlay);
      map.triggerRepaint();
      await waitForRender(() => {
        if (interleaved) {
          const renderedPixel = readCenterPixel(map.getCanvas().getContext('webgl2')!);
          if (renderedPixel[0] === 255) {
            centerPixel = renderedPixel;
          }
        }
        return Boolean(overlay._deck?.isInitialized && centerPixel[0] === 255);
      });

      expect(overlay._deck).toBeTruthy();
      expect(overlay.getCanvas() === map.getCanvas()).toBe(interleaved);
      if (interleaved) {
        expect(map.getLayersOrder()).toEqual([
          'deck-maplibre-layer-group-before:labels',
          'labels',
          'deck-maplibre-layer-group-last'
        ]);
      }

      expect(centerPixel).toEqual([255, 0, 0, 255]);

      map.jumpTo({center: [-122.4, 37.8], zoom: 12});
      map.triggerRepaint();
      await waitForRender(() => overlay._deck!.props.viewState.zoom === map.getZoom());

      const viewState = overlay._deck!.props.viewState;
      expect(viewState.longitude).toBeCloseTo(map.getCenter().lng);
      expect(viewState.latitude).toBeCloseTo(map.getCenter().lat);
      expect(viewState.zoom).toBe(map.getZoom());

      map.removeControl(overlay);
      expect(overlay._deck).toBeFalsy();
    }

    map.remove();
    container.remove();
  });
}

for (const {version, MapClass} of MAPLIBRE_VERSIONS) {
  webglTest(`MapLibreOverlay picks over terrain with MapLibre ${version}`, async () => {
    const container = document.createElement('div');
    Object.assign(container.style, {width: '400px', height: '300px'});
    document.body.append(container);
    const demTileURL = await createDemTileURL(1000);

    const summit: [number, number, number] = [8.5, 47.3, 1000];
    const map = new MapClass({
      container,
      style: {
        version: 8,
        sources: {dem: {type: 'raster-dem', tiles: [demTileURL], tileSize: 256, maxzoom: 12}},
        layers: []
      },
      center: [summit[0], summit[1]],
      zoom: 13,
      pitch: 60,
      attributionControl: false
    }) as unknown as MapLibreMap;

    try {
      await new Promise<void>(resolve => map.once('load', () => resolve()));

      const overlay = new MapLibreOverlay({
        interleaved: true,
        layers: [
          new ScatterplotLayer<[number, number, number]>({
            id: 'summit',
            data: [summit],
            getPosition: d => d,
            getRadius: 8,
            radiusUnits: 'pixels',
            pickable: true
          })
        ]
      });
      map.addControl(overlay);
      await waitForRender(() => Boolean(overlay._deck?.isInitialized));

      // MapLibre raises the center elevation as the terrain loads, without a move event
      map.setTerrain({source: 'dem'});
      await new Promise<void>(resolve => map.once('idle', () => resolve()));

      const elevation = getMapLibreElevation(map);
      expect(elevation).toBeCloseTo(1000);
      expect(overlay._deck!.props.viewState.position).toEqual([0, 0, elevation]);
      expect(overlay.pickObject({x: 200, y: 150})?.layer?.id).toBe('summit');
    } finally {
      map.remove();
      container.remove();
      URL.revokeObjectURL(demTileURL);
    }
  });
}

/**
 * Passes `renderTerrainHeightMap` to the deck.gl layer groups while the map has terrain, as MapLibre
 * releases that share their terrain do. The releases used in tests cannot share it yet.
 */
function shareTerrain(map: MapLibreMap, renderTerrainHeightMap: (target: any) => void): void {
  for (const id of map.getLayersOrder()) {
    const group = (map.getLayer(id) as any)?.implementation;
    if (id.startsWith('deck-maplibre-layer-group')) {
      const render = group.render.bind(group);
      group.render = (gl: WebGL2RenderingContext, options: object) =>
        render(gl, map.getTerrain() ? {...options, renderTerrainHeightMap} : options);
    }
  }
}

/** Returns the north-west corner of a tile, or of a fraction of one */
function tileToLngLat(x: number, y: number, z: number): [number, number] {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return [(x / 2 ** z) * 360 - 180, (180 / Math.PI) * Math.atan(Math.sinh(n))];
}

webglTest('MapLibreOverlay shares MapLibre terrain with TerrainExtension layers', async () => {
  const container = document.createElement('div');
  Object.assign(container.style, {width: '400px', height: '300px'});
  document.body.append(container);
  const demTileURL = await createDemTileURL(1000);

  // A terrain tile, and a trail across it a quarter of the tile below its north edge
  const tile = {canonical: {x: 4289, y: 2896, z: 13}, wrap: 0};
  const [west, north] = tileToLngLat(tile.canonical.x, tile.canonical.y, 13);
  const [east, south] = tileToLngLat(tile.canonical.x + 1, tile.canonical.y + 1, 13);
  const trailLatitude = tileToLngLat(0, tile.canonical.y + 0.25, 13)[1];
  const center: [number, number] = [(west + east) / 2, (north + south) / 2];

  const map = new MapLibreV6Map({
    container,
    style: {
      version: 8,
      sources: {dem: {type: 'raster-dem', tiles: [demTileURL], tileSize: 256, maxzoom: 12}},
      layers: [{id: 'labels', type: 'background', paint: {'background-opacity': 0}}]
    },
    center,
    zoom: 13,
    attributionControl: false
  }) as unknown as MapLibreMap;
  const gl = map.getCanvas().getContext('webgl2')!;
  // The ground is 1000 meters high
  const renderTerrainHeightMap = vi.fn(({texture}: {texture: WebGLTexture}) => {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearBufferfv(gl.COLOR, 0, [1000, 0, 0, 1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
  });

  try {
    await new Promise<void>(resolve => map.once('load', () => resolve()));
    const overlay = new MapLibreOverlay({
      interleaved: true,
      layers: [
        new ScatterplotLayer<[number, number]>({
          id: 'hut',
          data: [center],
          getPosition: d => d,
          getRadius: 8,
          radiusUnits: 'pixels',
          pickable: true,
          extensions: [new TerrainExtension()]
        }),
        new PathLayer<[number, number][]>({
          id: 'trail',
          data: [
            [
              [west - 0.01, trailLatitude],
              [east + 0.01, trailLatitude]
            ]
          ],
          getPath: d => d,
          getColor: [255, 0, 0],
          getWidth: 8,
          widthUnits: 'pixels',
          beforeId: 'labels',
          pickable: true,
          extensions: [new TerrainExtension()]
        })
      ]
    });
    map.addControl(overlay);
    await waitForRender(() => Boolean(overlay._deck?.isInitialized));
    const getDeckLayerIds = () => flatten(overlay._deck!.props.layers, Boolean).map(l => l.id);
    shareTerrain(map, renderTerrainHeightMap);

    map.setTerrain({source: 'dem'});
    await waitForRender(
      () => map.getLayersOrder().length === 4,
      () => map.triggerRepaint()
    );
    expect(getDeckLayerIds()).toEqual(['maplibre-terrain', 'hut', 'trail']);
    expect(map.getLayersOrder()).toEqual([
      'deck-maplibre-drape-group-before:labels',
      'deck-maplibre-layer-group-before:labels',
      'labels',
      'deck-maplibre-layer-group-last'
    ]);
    const drapeGroup = (map.getLayer('deck-maplibre-drape-group-before:labels') as any)
      .implementation;
    expect(drapeGroup.terrainTileRevision, 'Terrain tiles are drawn again').toBeGreaterThan(0);

    // The hut is placed by a height map of MapLibre's terrain
    expect(renderTerrainHeightMap).toHaveBeenCalled();
    const [{texture, width, height, bounds}] = renderTerrainHeightMap.mock.lastCall!;
    expect(texture).toBeInstanceOf(WebGLTexture);
    expect(width > 0 && height > 0).toBe(true);
    const x = (tile.canonical.x + 0.5) / 2 ** 13;
    const y = (tile.canonical.y + 0.5) / 2 ** 13;
    expect(
      bounds[0] < x && x < bounds[2] && bounds[1] < y && y < bounds[3],
      'Height map bounds'
    ).toBe(true);

    // Both layers are picked on the ground
    const viewport = overlay._deck!.getViewports()[0];
    const [hutX, hutY] = viewport.project([...center, 1000]);
    expect(overlay.pickObject({x: hutX, y: hutY})?.layer?.id).toBe('hut');
    const [trailX, trailY] = viewport.project([center[0] + 0.01, trailLatitude, 1000]);
    expect(overlay.pickObject({x: trailX, y: trailY})?.layer?.id).toBe('trail');

    // The trail is draped into the terrain tile, north up with the first row south
    const texture2 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture2);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 256);
    const tileFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tileFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture2, 0);
    gl.viewport(0, 0, 256, 256);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drapeGroup.renderToTerrainTile(gl, {tileID: tile, width: 256, height: 256});
    gl.bindFramebuffer(gl.FRAMEBUFFER, tileFramebuffer);
    const pixels = new Uint8Array(256 * 256 * 4);
    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const trailRows = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 200 && pixels[i + 3] > 200) {
        trailRows.add(Math.floor(i / 4 / 256));
      }
    }
    expect(trailRows.size, 'Trail is draped').toBeGreaterThan(0);
    expect(Math.min(...trailRows) >= 186 && Math.max(...trailRows) <= 198, 'Trail rows').toBe(true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tileFramebuffer);
    gl.deleteTexture(texture2);

    map.setTerrain(null);
    await waitForRender(
      () => map.getLayersOrder().length === 3 && getDeckLayerIds().length === 2,
      () => map.triggerRepaint()
    );
    expect(getDeckLayerIds()).toEqual(['hut', 'trail']);
    expect(map.getLayersOrder()).toEqual([
      'deck-maplibre-layer-group-before:labels',
      'labels',
      'deck-maplibre-layer-group-last'
    ]);
    map.removeControl(overlay);
  } finally {
    map.remove();
    container.remove();
    URL.revokeObjectURL(demTileURL);
  }
});
