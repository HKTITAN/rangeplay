// quake's GPU commands, run by the GPU worker: OP_FRAME carries one frame of Quake's software renderer as it draws it,
// 8-bit palette indices plus the 256-color palette (which the game changes for damage flashes and underwater tints).
// The palette lookup happens on the GPU, so a 640 x 480 frame is 300 KB through the ring instead of 1.2 MB.

const OP_FRAME = 16;
const PALETTE = 8, PIXELS = 8 + 1024; // payload: [u32 width][u32 height][256 x RGBA][width * height indices]
const ASPECT = 4 / 3;

const WGSL = /* wgsl */ `
@group(0) @binding(0) var pixels: texture_2d<u32>;
@group(0) @binding(1) var palette: texture_2d<f32>;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));   // a triangle covering the viewport
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment fn fs(v: V) -> @location(0) vec4f {
  let size = textureDimensions(pixels);
  let index = textureLoad(pixels, min(vec2u(v.uv * vec2f(size)), size - 1u), 0).r;
  return vec4f(textureLoad(palette, vec2u(index, 0u), 0).rgb, 1.0);
}
`;

function letterbox(w, h) {
  const s = Math.min(w / ASPECT, h);
  const vw = Math.floor(s * ASPECT), vh = Math.floor(s);
  return [Math.floor((w - vw) / 2), Math.floor((h - vh) / 2), vw, vh];
}

export async function setup(ctx) {
  return ctx.backend === 'webgpu' ? webgpu(ctx) : canvas2d(ctx);
}

function webgpu(ctx) {
  const { device, context, format } = ctx;
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
  });
  const palette = device.createTexture({ size: [256, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  let pixels = null, bindGroup = null, shared = true;

  return {
    [OP_FRAME](at) {
      const w = ctx.dv.getUint32(at, true), h = ctx.dv.getUint32(at + 4, true);
      if (!pixels || pixels.width !== w || pixels.height !== h) {
        pixels?.destroy();
        pixels = device.createTexture({ size: [w, h], format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: pixels.createView() }, { binding: 1, resource: palette.createView() }],
        });
      }
      const bytes = (from, n) => (shared ? ctx.u8.subarray(from, from + n) : ctx.u8.slice(from, from + n));
      const upload = () => {
        device.queue.writeTexture({ texture: palette }, bytes(at + PALETTE, 1024), { bytesPerRow: 1024 }, [256, 1]);
        device.queue.writeTexture({ texture: pixels }, bytes(at + PIXELS, w * h), { bytesPerRow: w }, [w, h]);
      };
      try {
        upload();
      } catch (e) {
        if (!shared) throw e;
        shared = false;   // a browser that will not copy from shared memory: go through a private buffer
        upload();
      }
    },
    frame() {
      const target = context.getCurrentTexture();
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }],
      });
      if (bindGroup) {
        pass.setViewport(...letterbox(target.width, target.height), 0, 1);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
      }
      pass.end();
      device.queue.submit([enc.finish()]);
    },
  };
}

function canvas2d(ctx) {
  const { canvas, ctx2d } = ctx;
  const palette = new Uint32Array(256);
  let image = null, rgba = null, offscreen = null;
  return {
    [OP_FRAME](at) {
      const w = ctx.dv.getUint32(at, true), h = ctx.dv.getUint32(at + 4, true);
      if (!image || image.width !== w || image.height !== h) {
        image = new ImageData(w, h);
        rgba = new Uint32Array(image.data.buffer);
        offscreen = new OffscreenCanvas(w, h);
      }
      // the palette entries are RGBA bytes, which is how ImageData stores a pixel
      for (let i = 0; i < 256; i++) palette[i] = ctx.dv.getUint32(at + PALETTE + i * 4, true);
      const src = ctx.u8;
      for (let i = 0, s = at + PIXELS; i < rgba.length; i++, s++) rgba[i] = palette[src[s]];
      offscreen.getContext('2d').putImageData(image, 0, 0);
    },
    frame() {
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      if (!offscreen) return;
      ctx2d.imageSmoothingEnabled = false;
      const [x, y, w, h] = letterbox(canvas.width, canvas.height);
      ctx2d.drawImage(offscreen, x, y, w, h);
    },
  };
}
