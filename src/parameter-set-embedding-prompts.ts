import type { LayoutConstraints } from './types';

/**
 * Rich sensory pattern descriptions for embedding generation
 * Each pattern combines map size, building count, and biome with extensive
 * synonyms, adjectives, and sensory language to capture broad semantic intent
 */

export interface ParameterSetPattern {
  pattern: string;
  constraints: Partial<LayoutConstraints>;
}

/**
 * Map size descriptions with rich sensory language
 */
const MAP_SIZE_DESCRIPTIONS = {
  small: 'compact, tiny, miniature, diminutive, petite map with limited scope, tight boundaries, cozy dimensions, intimate scale, narrow expanse',
  medium: 'moderate, standard, average-sized map with balanced proportions, comfortable scale, typical dimensions, standard scope',
  large: 'expansive, vast, extensive, spacious, wide-ranging map with broad boundaries, generous scale, ample dimensions, sweeping expanse',
} as const;

/**
 * Building count descriptions with rich sensory language
 */
const BUILDING_COUNT_DESCRIPTIONS = {
  few: 'sparse, scattered, minimal, scarce, rare buildings with wide open spaces between structures, low density, scattered settlements, isolated structures',
  'mid-range': 'moderate, balanced, typical number of buildings with standard density, evenly distributed structures, normal settlement pattern',
  many: 'dense, numerous, abundant, plentiful buildings with high density, crowded settlements, tightly packed structures, bustling urban areas',
} as const;

/**
 * Biome descriptions with rich sensory language
 */
const BIOME_DESCRIPTIONS = {
  grass: 'lush, verdant, emerald, vibrant green grasslands, rolling meadows, soft grassy terrain, pastoral fields, green expanses, grassy plains',
  water: 'aquatic, watery, blue, flowing water features, lakes, rivers, streams, wet terrain, aquatic environments, water bodies',
  forest: 'wooded, forested, tree-covered, dense woodland, lush forests, wooded areas, forested terrain, tree-filled landscape, arboreal environments',
} as const;

/**
 * Constraint value mappings
 */
const MAP_SIZE_CONSTRAINTS = {
  small: { maxLayer: 10 },
  medium: { maxLayer: 20 },
  large: { maxLayer: 35 },
} as const;

const BUILDING_COUNT_CONSTRAINTS = {
  few: { buildingCount: 4 },
  'mid-range': { buildingCount: 10 },
  many: { buildingCount: 20 },
} as const;

const BIOME_CONSTRAINTS = {
  grass: { primaryTileType: 'grass' as const, grassRatio: 0.7 },
  water: { primaryTileType: 'water' as const },
  forest: { primaryTileType: 'forest' as const },
} as const;

/**
 * Generate all 27 combinations of map size, building count, and biome
 * Each pattern combines rich sensory descriptions for semantic matching
 */
export function generateParameterSetPatterns(): Array<ParameterSetPattern> {
  const patterns: Array<ParameterSetPattern> = [];
  
  const mapSizes: Array<keyof typeof MAP_SIZE_DESCRIPTIONS> = ['small', 'medium', 'large'];
  const buildingCounts: Array<keyof typeof BUILDING_COUNT_DESCRIPTIONS> = ['few', 'mid-range', 'many'];
  const biomes: Array<keyof typeof BIOME_DESCRIPTIONS> = ['grass', 'water', 'forest'];
  
  for (const mapSize of mapSizes) {
    for (const buildingCount of buildingCounts) {
      for (const biome of biomes) {
        // Combine rich descriptions into a single pattern
        const pattern = `A ${MAP_SIZE_DESCRIPTIONS[mapSize]} featuring ${BUILDING_COUNT_DESCRIPTIONS[buildingCount]} set within ${BIOME_DESCRIPTIONS[biome]}`;
        
        // Combine constraints from all three dimensions
        const constraints: Partial<LayoutConstraints> = {
          ...MAP_SIZE_CONSTRAINTS[mapSize],
          ...BUILDING_COUNT_CONSTRAINTS[buildingCount],
          ...BIOME_CONSTRAINTS[biome],
        };
        
        patterns.push({ pattern, constraints });
      }
    }
  }
  
  return patterns;
}

/**
 * All 27 parameter set patterns for embedding generation
 * Pre-computed to avoid regeneration on every access
 */
export const PARAMETER_SET_PATTERNS: Array<ParameterSetPattern> = generateParameterSetPatterns();

