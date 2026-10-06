// freedoom's GPU commands, run by the GPU worker: OP_FRAME carries one frame of the engine's software renderer
// (xrgb8888, 640 x 400), which is uploaded to a texture and drawn letterboxed at 4:3, the shape Doom was drawn for.

const OP_FRAME = 16;
const ASPECT = 4 / 3;

const WGSL = /* wgsl */ `
@group(0) @binding(0) var frame: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));   // a triangle covering the viewport
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment fn fs(v: V) -> @location(0) vec4f {
  return vec4f(textureSample(frame, samp, v.uv).rgb, 1.0);
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
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'linear' });
  let texture = null, bindGroup = null, shared = true;

  return {
    [OP_FRAME](at) {
      const w = ctx.dv.getUint32(at, true), h = ctx.dv.getUint32(at + 4, true);
      if (!texture || texture.width !== w || texture.height !== h) {
        texture?.destroy();
        // the engine's pixels are 0x00RRGGBB words: in memory B, G, R, X
        texture = device.createTexture({ size: [w, h], format: 'bgra8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }],
        });
      }
      const n = w * h * 4, src = at + 8;
      const upload = () => device.queue.writeTexture({ texture }, shared ? ctx.u8.subarray(src, src + n) : ctx.u8.slice(src, src + n), { bytesPerRow: w * 4 }, [w, h]);
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
  let image = null, offscreen = null;
  return {
    [OP_FRAME](at) {
      const w = ctx.dv.getUint32(at, true), h = ctx.dv.getUint32(at + 4, true);
      if (!image || image.width !== w || image.height !== h) {
        image = new ImageData(w, h);
        offscreen = new OffscreenCanvas(w, h);
      }
      const src = ctx.u8, d = image.data;
      for (let i = 0, s = at + 8; i < d.length; i += 4, s += 4) {
        d[i] = src[s + 2];
        d[i + 1] = src[s + 1];
        d[i + 2] = src[s];
        d[i + 3] = 255;
      }
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
