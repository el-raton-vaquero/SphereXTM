import * as THREE from 'three';

/**
 * Procedural SPHEREx spacecraft (no official NASA 3D model was found on
 * science.nasa.gov/3d-resources on 2026-11-14). Built from primitives after
 * public NASA/JPL artwork: three nested conical photon shields opening upward
 * around a 20 cm telescope, a six-sided bus below, and one fixed solar array.
 *
 * Model space: +Y = telescope boresight (points away from Earth in orbit),
 * +X = solar-array normal (faces the Sun in a dawn–dusk orbit).
 * Height ≈ 2.6 units ≈ metres. Proportions are approximate.
 */
export function buildSpacecraft(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'spherex';

  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0xd9d4cb,
    metalness: 0.55,
    roughness: 0.38,
    side: THREE.DoubleSide,
  });
  const innerShieldMat = shieldMat.clone();
  innerShieldMat.color = new THREE.Color(0xa8a39a);
  const busMat = new THREE.MeshStandardMaterial({ color: 0x3a3733, metalness: 0.3, roughness: 0.7 });
  const mliMat = new THREE.MeshStandardMaterial({ color: 0x8a7650, metalness: 0.6, roughness: 0.45 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xece8e1, transparent: true, opacity: 0.35 });

  const addEdges = (mesh: THREE.Mesh, threshold = 20) => {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold), edgeMat);
    e.position.copy(mesh.position);
    e.rotation.copy(mesh.rotation);
    e.scale.copy(mesh.scale);
    g.add(e);
  };

  // Bus: six-sided prism.
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.62, 6), busMat);
  bus.position.y = 0.31;
  g.add(bus);
  addEdges(bus);

  // Gold MLI deck between bus and shields.
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.06, 6), mliMat);
  deck.position.y = 0.65;
  g.add(deck);

  // Three nested photon shields: open frustums, widening upward.
  const shields: Array<[number, number, number, number, THREE.Material]> = [
    // bottomR, topR, bottomY, topY
    [0.42, 0.86, 0.78, 1.78, innerShieldMat],
    [0.52, 1.04, 0.74, 2.04, shieldMat],
    [0.62, 1.24, 0.7, 2.32, shieldMat],
  ];
  for (const [rb, rt, yb, yt, mat] of shields) {
    const h = yt - yb;
    const geo = new THREE.CylinderGeometry(rt, rb, h, 48, 1, true);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = yb + h / 2;
    g.add(m);
    // Rim hairlines only (top & bottom circles) to read like a drawing.
    for (const [r, y] of [[rt, yt], [rb, yb]] as const) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), edgeMat));
    }
  }

  // Telescope: barrel + dark aperture.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.85, 32), busMat);
  tube.position.y = 1.1;
  g.add(tube);
  const aperture = new THREE.Mesh(
    new THREE.CircleGeometry(0.19, 32),
    new THREE.MeshBasicMaterial({ color: 0x050505 }),
  );
  aperture.rotation.x = -Math.PI / 2;
  aperture.position.y = 1.53;
  g.add(aperture);

  // Solar array on a short boom, normal along +X.
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8), busMat);
  boom.rotation.z = Math.PI / 2;
  boom.position.set(0.82, 0.25, 0);
  g.add(boom);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.1, 1.5), panelMat);
  panel.position.set(1.08, 0.2, 0);
  g.add(panel);
  addEdges(panel);
  // Cell grid hairlines.
  const grid: THREE.Vector3[] = [];
  for (let i = 1; i < 6; i++) {
    const z = -0.75 + (i * 1.5) / 6;
    grid.push(new THREE.Vector3(1.1, -0.35, z), new THREE.Vector3(1.1, 0.75, z));
  }
  for (let i = 1; i < 4; i++) {
    const y = -0.35 + (i * 1.1) / 4;
    grid.push(new THREE.Vector3(1.1, y, -0.75), new THREE.Vector3(1.1, y, 0.75));
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), edgeMat));

  // Small fixed antenna under the bus.
  const ant = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.12, 24, 1, true), mliMat);
  ant.position.set(-0.25, -0.06, 0.2);
  ant.rotation.x = Math.PI;
  g.add(ant);

  return g;
}

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
