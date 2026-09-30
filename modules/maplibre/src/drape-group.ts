// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getMapLibreDeckInstance, getMapLibreTerrain} from './deck-utils';

import type {FilterContext, Layer} from '@deck.gl/core';
import type {CustomLayerInterface, Map as MapLibreMap} from 'maplibre-gl';
import type {MapLibreLayerProps} from './layer-utils';
import type {TerrainTileInput} from './terrain';

export type MapLibreDrapeGroupProps = {
  id: string;
  beforeId?: string;
};

/** Draws the draped deck.gl layers of one layer group into MapLibre's terrain tiles */
export default class MapLibreDrapeGroup implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  readonly beforeId?: string;

  private map: MapLibreMap | null = null;

  constructor(props: MapLibreDrapeGroupProps) {
    this.id = props.id;
    this.beforeId = props.beforeId;
  }

  onAdd(map: MapLibreMap): void {
    this.map = map;
  }

  onRemove(): void {
    this.map = null;
  }

  /** Changes when the draped layers change, so that MapLibre draws its terrain tiles again */
  get terrainTileRevision(): number {
    return (this.map && getMapLibreTerrain(this.map)?.tileRevision) ?? 0;
  }

  /** Draped layers are drawn by their layer group while MapLibre has no terrain */
  render(): void {}

  renderToTerrainTile(gl: WebGL2RenderingContext, input: TerrainTileInput): void {
    const map = this.map;
    const deck = map && getMapLibreDeckInstance(map);
    if (!map || !deck) {
      return;
    }
    getMapLibreTerrain(map)?.drawTile(gl, input, (params: FilterContext) => {
      if (deck.props.layerFilter && !deck.props.layerFilter(params)) {
        return false;
      }
      return (params.layer as Layer<MapLibreLayerProps>).props.beforeId === this.beforeId;
    });
  }
}
