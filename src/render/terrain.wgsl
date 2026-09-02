struct Uniforms {
  viewProj: mat4x4<f32>,
  // xyz = directional light vector (toward the light), w unused.
  lightDir: vec4<f32>,
  // x/y = world-space distance between adjacent height-field texels
  // (column/row), z = max soil depth (for material-fraction colouring), w unused.
  worldStep: vec4<f32>,
  // Hypsometric relief tint (src/render/reliefTheme.ts):
  //   x = sea level (world height), y = belowSpan, z = aboveSpan,
  //   w = materialMix (0 = pure elevation tint .. 1 = pure material colour).
  relief: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var earthTex: texture_2d<f32>;
@group(0) @binding(3) var sandTex: texture_2d<f32>;
// 1-D elevation → colour lookup, baked from the active ReliefTheme. Sea level
// is the boundary between the two halves; see buildReliefLUT for the mapping.
@group(0) @binding(4) var reliefLut: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) texel: vec2<f32>,
};

@vertex
fn vs_main(@location(0) groundPos: vec2<f32>, @location(1) texel: vec2<f32>) -> VertexOutput {
  let coord = vec2<i32>(i32(texel.x), i32(texel.y));
  let height = textureLoad(heightTex, coord, 0).r;
  let worldPos = vec3<f32>(groundPos.x, height, groundPos.y);

  var out: VertexOutput;
  out.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  out.texel = texel;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Direct texel fetches, no sampler — exact per-cell values, not
  // interpolated ones. Correct for a heightfield that will later be a
  // compute-shader-updated simulation grid, and sidesteps the
  // float32-filterable optional-feature question entirely.
  let base = vec2<i32>(i32(round(in.texel.x)), i32(round(in.texel.y)));
  // Left/right (same row, adjacent column) are genuine hex neighbours
  // regardless of row parity — no correction needed.
  let hL = textureLoad(heightTex, base + vec2<i32>(-1, 0), 0).r;
  let hR = textureLoad(heightTex, base + vec2<i32>(1, 0), 0).r;
  // Up/down are NOT: a true hex neighbour one row away needs a column
  // offset that flips with row parity (same reason the mesh triangulation
  // needed to alternate its diagonal — see buildHexMesh). Using a fixed
  // (0,-1)/(0,1) offset here is only a real neighbour for one parity and
  // produces a regular banding artifact in the shading, independent of
  // whether the mesh geometry itself is correct.
  let rowEven = (base.y & 1) == 0;
  let upOffset = select(vec2<i32>(1, 1), vec2<i32>(0, 1), rowEven);
  let downOffset = select(vec2<i32>(0, -1), vec2<i32>(-1, -1), rowEven);
  let hU = textureLoad(heightTex, base + upOffset, 0).r;
  let hD = textureLoad(heightTex, base + downOffset, 0).r;

  let dHdx = (hR - hL) / (2.0 * uniforms.worldStep.x);
  let dHdz = (hU - hD) / (2.0 * uniforms.worldStep.y);
  let normal = normalize(vec3<f32>(-dHdx, 1.0, -dHdz));

  let lightDir = normalize(uniforms.lightDir.xyz);
  let diffuse = max(dot(normal, lightDir), 0.0);
  let ambient = 0.3;

  // --- material colour (rock / earth / sand exposed at this cell) ---------
  // rock isn't a clean 0..1 fraction (it's a bedrock *height*, any sign or
  // magnitude) — but earth+sand are clean small depths, so rock's share is
  // "whatever fraction of maxSoilDepth isn't soil".
  let maxSoilDepth = uniforms.worldStep.z;
  let earthDepth = textureLoad(earthTex, base, 0).r;
  let sandDepth = textureLoad(sandTex, base, 0).r;
  let soilDepth = earthDepth + sandDepth;
  let rockFrac = clamp(1.0 - soilDepth / maxSoilDepth, 0.0, 1.0);
  let sandFracOfSoil = sandDepth / max(soilDepth, 0.001);

  let rockColor = vec3<f32>(0.5, 0.5, 0.52);
  let earthColor = vec3<f32>(0.45, 0.33, 0.2);
  let sandColor = vec3<f32>(0.76, 0.7, 0.5);
  let soilColor = mix(earthColor, sandColor, sandFracOfSoil);
  let materialColor = mix(soilColor, rockColor, rockFrac);

  // --- hypsometric relief tint ------------------------------------------
  // Map this cell's height to a texel in the 1-D relief LUT, using the same
  // sea-level-on-the-half-boundary convention as buildReliefLUT.
  let hC = textureLoad(heightTex, base, 0).r;
  let seaLevel = uniforms.relief.x;
  let lutW = i32(textureDimensions(reliefLut).x);
  let lutHalf = lutW / 2;
  var lutX: i32;
  if (hC < seaLevel) {
    let u = clamp((seaLevel - hC) / max(uniforms.relief.y, 0.001), 0.0, 1.0); // 0 at sea, 1 deepest
    lutX = (lutHalf - 1) - i32(round(u * f32(lutHalf - 1)));
  } else {
    let u = clamp((hC - seaLevel) / max(uniforms.relief.z, 0.001), 0.0, 1.0); // 0 at sea, 1 highest
    lutX = lutHalf + i32(round(u * f32(lutHalf - 1)));
  }
  lutX = clamp(lutX, 0, lutW - 1);
  let hypsoColor = textureLoad(reliefLut, vec2<i32>(lutX, 0), 0).rgb;

  let baseColor = mix(hypsoColor, materialColor, uniforms.relief.w);
  let color = baseColor * (ambient + diffuse * 0.75);
  return vec4<f32>(color, 1.0);
}
