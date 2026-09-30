// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';

import type {DefaultProps, LayerProps} from '@deck.gl/core';
import type {MapLibreTerrain} from './terrain';

type MapLibreTerrainLayerProps = {
  /** The terrain of the map, which layers with the TerrainExtension follow */
  externalTerrain: MapLibreTerrain | null;
};

const defaultProps: DefaultProps<MapLibreTerrainLayerProps & LayerProps> = {
  operation: 'terrain',
  pickable: true,
  externalTerrain: {type: 'object', value: null, compare: false}
};

/**
 * Stands for the terrain of a MapLibre map among the deck.gl layers, which layers with the
 * TerrainExtension follow. MapLibre draws the terrain, so this layer only draws it for picking.
 */
export default class MapLibreTerrainLayer extends Layer<MapLibreTerrainLayerProps> {
  static defaultProps = defaultProps;
  static layerName = 'MapLibreTerrainLayer';

  initializeState(): void {}

  draw({renderPass, parameters, shaderModuleProps}): void {
    shaderModuleProps?.terrain?.drawPickingSurface?.({renderPass, parameters, shaderModuleProps});
  }
}
