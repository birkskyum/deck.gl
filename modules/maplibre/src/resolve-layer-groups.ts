// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_flatten as flatten} from '@deck.gl/core';

import MapLibreLayerGroup from './layer-group';
import MapLibreDrapeGroup from './drape-group';
import {getMapLibreDrapeGroupId, getMapLibreLayerGroupId} from './layer-utils';
import {getMapLibreTerrain} from './deck-utils';

import type {Layer, LayersList} from '@deck.gl/core';
import type {Map as MapLibreMap} from 'maplibre-gl';
import type {MapLibreLayerProps} from './layer-utils';

const LAYER_GROUPS = new WeakMap<MapLibreMap, Map<string, MapLibreLayerGroup>>();
const DRAPE_GROUPS = new WeakMap<MapLibreMap, Map<string, MapLibreDrapeGroup>>();

// eslint-disable-next-line complexity, max-statements
export function resolveMapLibreLayerGroups(
  map?: MapLibreMap,
  oldLayers?: LayersList,
  newLayers?: LayersList
): void {
  if (!map || !map.isStyleLoaded()) {
    return;
  }

  let layerGroups = LAYER_GROUPS.get(map);
  if (!layerGroups) {
    layerGroups = new Map();
    LAYER_GROUPS.set(map, layerGroups);
  }

  const layers = flatten(newLayers, Boolean) as Layer<MapLibreLayerProps>[];
  const newLayerGroupIds = new Set(layers.map(getMapLibreLayerGroupId));

  if (oldLayers !== newLayers) {
    const previousLayers = flatten(oldLayers, Boolean) as Layer<MapLibreLayerProps>[];
    const previousLayerGroupIds = new Set(previousLayers.map(getMapLibreLayerGroupId));
    for (const groupId of previousLayerGroupIds) {
      if (!newLayerGroupIds.has(groupId) && layerGroups.has(groupId)) {
        if (map.getLayer(groupId)) {
          map.removeLayer(groupId);
        }
        layerGroups.delete(groupId);
      }
    }
  }

  for (const layer of layers) {
    const groupId = getMapLibreLayerGroupId(layer);
    if (layerGroups.has(groupId)) {
      if (!map.getLayer(groupId)) {
        map.addLayer(layerGroups.get(groupId)!, layer.props.beforeId);
      }
      continue;
    }

    if (map.getLayer(groupId)) {
      throw new Error(`MapLibre style already contains a non-deck layer with id ${groupId}`);
    }

    const group = new MapLibreLayerGroup({
      id: groupId,
      beforeId: layer.props.beforeId
    });
    layerGroups.set(groupId, group);
    map.addLayer(group, layer.props.beforeId);
  }

  for (const groupId of newLayerGroupIds) {
    const group = layerGroups.get(groupId)!;
    const mapLayers = map.getLayersOrder();
    const expectedGroupIndex = group.beforeId
      ? mapLayers.indexOf(group.beforeId)
      : mapLayers.length;
    if (expectedGroupIndex < 0) {
      continue;
    }

    const currentGroupIndex = mapLayers.indexOf(groupId);
    if (currentGroupIndex !== expectedGroupIndex - 1) {
      map.moveLayer(groupId, group.beforeId);
    }
  }

  resolveMapLibreDrapeGroups(map, layerGroups, newLayerGroupIds);
}

/**
 * While the map has terrain, puts a drape group right below each layer group, which draws the
 * group's draped layers into the terrain tiles.
 */
function resolveMapLibreDrapeGroups(
  map: MapLibreMap,
  layerGroups: Map<string, MapLibreLayerGroup>,
  layerGroupIds: Set<string>
): void {
  let drapeGroups = DRAPE_GROUPS.get(map);
  if (!drapeGroups) {
    drapeGroups = new Map();
    DRAPE_GROUPS.set(map, drapeGroups);
  }
  const terrain = map.getTerrain() ? getMapLibreTerrain(map) : null;
  const isDraped = (groupId: string) =>
    Boolean(terrain?.hasDrapedLayers(layerGroups.get(groupId)?.beforeId));

  for (const [groupId, drapeGroup] of drapeGroups) {
    if (!layerGroupIds.has(groupId) || !isDraped(groupId)) {
      if (map.getLayer(drapeGroup.id)) {
        map.removeLayer(drapeGroup.id);
      }
      drapeGroups.delete(groupId);
    }
  }
  for (const groupId of layerGroupIds) {
    if (!isDraped(groupId)) {
      continue;
    }
    const {beforeId} = layerGroups.get(groupId)!;
    let drapeGroup = drapeGroups.get(groupId);
    if (!drapeGroup) {
      drapeGroup = new MapLibreDrapeGroup({id: getMapLibreDrapeGroupId(beforeId), beforeId});
      drapeGroups.set(groupId, drapeGroup);
    }
    if (!map.getLayer(drapeGroup.id)) {
      map.addLayer(drapeGroup, groupId);
      continue;
    }
    const mapLayers = map.getLayersOrder();
    if (mapLayers.indexOf(drapeGroup.id) !== mapLayers.indexOf(groupId) - 1) {
      map.moveLayer(drapeGroup.id, groupId);
    }
  }
}
