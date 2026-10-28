import * as THREE from 'three';
import { createHomeToonRamp } from './living-home-toon-style';

/** Restyle the existing GLB in memory. No model generation, geometry replacement or asset requests. */
export function applyCompanionToon(root:THREE.Object3D):void {
  if(root.userData.companionToon)return;root.userData.companionToon=true;
  const ramp=createHomeToonRamp();
  const replacements=new Map<THREE.Material,THREE.MeshToonMaterial>(),outlines:Array<{parent:THREE.Object3D;mesh:THREE.Mesh}>=[];
  const viewport=new THREE.Vector2(1,1);
  const outlineMaterial=new THREE.MeshBasicMaterial({color:'#82917e',side:THREE.BackSide,transparent:true,opacity:.6,depthWrite:false,toneMapped:false});
  outlineMaterial.stencilWrite=true;outlineMaterial.stencilRef=1;outlineMaterial.stencilFunc=THREE.NotEqualStencilFunc;outlineMaterial.stencilWriteMask=0;
  outlineMaterial.onBeforeCompile=shader=>{
    shader.uniforms.outlineViewport={value:viewport};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform vec2 outlineViewport;')
      .replace('#include <project_vertex>','#include <project_vertex>\nvec2 outlineNormal=(normalMatrix*normal).xy;float outlineLength=length(outlineNormal);if(outlineLength>0.001)gl_Position.xy+=outlineNormal/outlineLength*1.7/outlineViewport*gl_Position.w;');
  };
  outlineMaterial.customProgramCacheKey=()=> 'companion-light-outline-v1';
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh)||object.userData.companionOutline)return;
    const convert=(old:THREE.Material)=>{
      let material=replacements.get(old);if(material)return material;
      const source=old as THREE.MeshStandardMaterial;
      const map=source.map??source.emissiveMap??null;
      material=new THREE.MeshToonMaterial({color:source.color??'#fff5e7',map,gradientMap:ramp,side:old.side,transparent:old.transparent,opacity:old.opacity,alphaTest:old.alphaTest,depthWrite:old.depthWrite,
        emissive:'#fff0d6',emissiveIntensity:.045});
      material.stencilWrite=true;material.stencilRef=1;material.stencilFunc=THREE.AlwaysStencilFunc;material.stencilZPass=THREE.ReplaceStencilOp;
      material.userData={...old.userData,companionToon:true,homeOwnedTextures:[ramp,...Object.values(old).filter(value=>value instanceof THREE.Texture)]};
      material.onBeforeCompile=shader=>{
        // Coarser mip sampling removes fur microcontrast. Posterize perceptual color while retaining the face markings.
        shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
          vec4 sampledDiffuseColor=texture2D(map,vMapUv,1.5);
          vec3 originalColor=sampledDiffuseColor.rgb;
          vec3 softColor=sqrt(clamp(sampledDiffuseColor.rgb,0.0,1.0));
          vec3 bands=floor(softColor*4.0+0.5)/4.0;
          sampledDiffuseColor.rgb=mix(sampledDiffuseColor.rgb,bands*bands,0.93);
          float hi=max(softColor.r,max(softColor.g,softColor.b));float lo=min(softColor.r,min(softColor.g,softColor.b));
          float lightness=dot(softColor,vec3(0.299,0.587,0.114));
          if(lightness>0.78&&hi-lo<0.2)sampledDiffuseColor.rgb=mix(sampledDiffuseColor.rgb,vec3(0.92,0.86,0.72),0.65);
          if(lightness<0.55)sampledDiffuseColor.rgb=originalColor;
          diffuseColor*=sampledDiffuseColor;
        #endif`);
      };
      material.customProgramCacheKey=()=> 'companion-home-four-color-toon-v3';
      replacements.set(old,material);return material;
    };
    object.material=Array.isArray(object.material)?object.material.map(convert):convert(object.material);
    object.renderOrder=1;
    // Inverted hull: shared geometry, one extra draw per mesh, a light ~0.85 CSS-pixel contour.
    const outline=object.clone(false);outline.name='companion-toon-outline';outline.material=outlineMaterial;
    outline.userData={companionOutline:true};outline.castShadow=outline.receiveShadow=false;outline.raycast=()=>undefined;
    outline.renderOrder=2;
    outline.onBeforeRender=renderer=>{renderer.getSize(viewport);};
    if(object.parent)outlines.push({parent:object.parent,mesh:outline});
  });
  outlines.forEach(({parent,mesh})=>parent.add(mesh));
  replacements.forEach((_next,old)=>old.dispose());
  if(!replacements.size){ramp.dispose();outlineMaterial.dispose();}
}
