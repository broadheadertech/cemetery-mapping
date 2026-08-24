"use client";

/**
 * The park in three dimensions — the public counterpart to
 * `CemeteryMapSVG`.
 *
 * Both views render the same plan from `./cemetery-model`, so a visitor
 * toggling between them sees the same gardens with the same lots in the
 * same states. The model is the contract; this file only decides how it
 * looks standing up.
 *
 * ## How it is put together
 *
 * Three.js has no React reconciler, so the scene is built imperatively
 * inside one mount effect and torn down completely on unmount — every
 * geometry, material, and the renderer itself, because WebGL resources
 * are not garbage collected with the React tree. The surrounding chrome
 * stays ordinary React. This mirrors `Phase3DMap` in the staff app.
 *
 * ## Why this is not `Phase3DMap`
 *
 * That component reads live inventory through `lots:listLots`, which is
 * role-gated. On a public marketing page there is no session, so the
 * query would fail. This scene is deliberately smaller and reads the
 * brochure plan instead — no auth, no data exposure decision, and a
 * fraction of the code.
 *
 * ## Cost
 *
 * Three.js is far too heavy to sit in a marketing page's first load, so
 * the route imports this lazily and only when a visitor asks for 3D.
 * Until they click, the bundle is unchanged.
 *
 * ## Accessibility
 *
 * A WebGL canvas is one opaque element to a screen reader. The flat SVG
 * remains the default and the accessible path — every lot there is a
 * real node with a label. This view is an enhancement, it announces
 * itself as a picture, and the lot detail it drives is ordinary DOM
 * beside it. If WebGL is unavailable the component says so and invites
 * the visitor back to the plan rather than showing a blank rectangle.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  type CemeterySectionPick,
  type LotStatus,
  lotsOf,
  PLAN_COLORS,
  PLAN_HEIGHT,
  PLAN_WIDTH,
  SECTIONS,
} from "./cemetery-model";

/** Plan units are large; scale them down to a comfortable world size. */
const SCALE = 0.06;

/** How tall each status stands. Occupied plots read as raised ground. */
const LOT_HEIGHT: Record<LotStatus, number> = {
  available: 0.16,
  reserved: 0.34,
  occupied: 0.62,
};

/**
 * Surface colours for the 3D view. Occupied and reserved match the flat
 * plan exactly; `available` does not, and deliberately.
 *
 * On paper an available lot is white with an emerald stroke, which
 * reads because the stroke does the work. Standing up on a white slab,
 * a white block is invisible — so the status the page most wants a
 * visitor to notice becomes the one they cannot see. Here it takes a
 * pale sage, close to turf, which keeps the emerald / gold / open
 * vocabulary intact while actually being visible.
 *
 * The statuses themselves come from the shared model; only how they are
 * painted differs between the two views.
 */
const SURFACE_COLOR: Record<LotStatus, string> = {
  available: "#CBDCD2",
  reserved: PLAN_COLORS.gold,
  occupied: PLAN_COLORS.emerald,
};

interface LotHit {
  code: string;
  section: string;
  status: LotStatus;
}

/** Plan coordinates → world coordinates, centred on the origin. */
function toWorld(x: number, y: number): [number, number] {
  return [(x - PLAN_WIDTH / 2) * SCALE, (y - PLAN_HEIGHT / 2) * SCALE];
}

export function CemeteryMap3D({
  onSelect,
  selectedId,
  filter = "all",
}: {
  onSelect?: (pick: CemeterySectionPick) => void;
  selectedId?: string;
  filter?: "all" | LotStatus;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  // The scene reads these through refs so a filter or selection change
  // never rebuilds the whole scene — only repaints the affected meshes.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const applyStateRef = useRef<
    ((selected: string | undefined, filter: string) => void) | null
  >(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }

    const width = mount.clientWidth || 800;
    const height = mount.clientHeight || 480;

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.borderRadius = "2px";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PLAN_COLORS.ivoryDeep);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 400);
    camera.position.set(0, 26, 32);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 12;
    controls.maxDistance = 70;
    // Never let the camera go under the ground — the park seen from
    // below is disorienting and, on a memorial site, unseemly.
    controls.maxPolarAngle = Math.PI / 2.35;
    controls.target.set(0, 0, 0);

    // Soft, high daylight. No hard theatrical key light: this is a
    // memorial park, and the brand voice is restrained.
    //
    // The intensities look high because three.js r155+ interprets them
    // physically. At the values older examples use, the ivory ground
    // renders as a flat mid-grey — the park loses its warmth and reads
    // like a wireframe.
    scene.add(new THREE.HemisphereLight(0xfbf6ea, 0xe4dcc8, 2.1));
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.9);
    sun.position.set(14, 26, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    scene.add(sun);

    /** Everything created here, tracked so teardown can free all of it. */
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    // ---- ground ----------------------------------------------------
    const groundGeo = track(
      new THREE.PlaneGeometry(PLAN_WIDTH * SCALE + 6, PLAN_HEIGHT * SCALE + 6),
    );
    const groundMat = track(
      new THREE.MeshStandardMaterial({
        color: PLAN_COLORS.ivory,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // ---- avenues ---------------------------------------------------
    // The same two paths the flat plan draws: one across, one down.
    const pathMat = track(
      new THREE.MeshStandardMaterial({
        color: PLAN_COLORS.stone,
        roughness: 1,
        metalness: 0,
      }),
    );
    const avenueH = track(
      new THREE.BoxGeometry(740 * SCALE, 0.05, 6 * SCALE * 2.2),
    );
    const avenueMeshH = new THREE.Mesh(avenueH, pathMat);
    const [, avenueHz] = toWorld(0, 240);
    avenueMeshH.position.set(0, 0.03, avenueHz);
    avenueMeshH.receiveShadow = true;
    scene.add(avenueMeshH);

    const avenueV = track(
      new THREE.BoxGeometry(4 * SCALE * 2.2, 0.05, 420 * SCALE),
    );
    const avenueMeshV = new THREE.Mesh(avenueV, pathMat);
    const [avenueVx] = toWorld(400, 0);
    avenueMeshV.position.set(avenueVx, 0.03, 0);
    avenueMeshV.receiveShadow = true;
    scene.add(avenueMeshV);

    // ---- sections --------------------------------------------------
    // One shared material for every lot outline.
    const edgeMaterial = track(
      new THREE.LineBasicMaterial({
        color: PLAN_COLORS.emerald,
        transparent: true,
        opacity: 0.5,
      }),
    );

    const slabMat = track(
      new THREE.MeshStandardMaterial({
        color: PLAN_COLORS.paper,
        roughness: 0.9,
        metalness: 0,
      }),
    );

    interface LotEntry {
      mesh: THREE.Mesh;
      material: THREE.MeshStandardMaterial;
      /** The lot's outline, hidden when the lot is filtered out. */
      edgeLine: THREE.LineSegments;
      data: LotHit;
      baseY: number;
    }
    const lotEntries: LotEntry[] = [];

    for (const section of SECTIONS) {
      const slabGeo = track(
        new THREE.BoxGeometry(section.w * SCALE, 0.1, section.h * SCALE),
      );
      const slab = new THREE.Mesh(slabGeo, slabMat);
      const [sx, sz] = toWorld(
        section.x + section.w / 2,
        section.y + section.h / 2,
      );
      slab.position.set(sx, 0.05, sz);
      slab.receiveShadow = true;
      scene.add(slab);

      for (const lot of lotsOf(section)) {
        const h = LOT_HEIGHT[lot.status];
        const geo = track(
          new THREE.BoxGeometry(lot.w * SCALE, h, lot.h * SCALE),
        );
        const material = track(
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(SURFACE_COLOR[lot.status]),
            roughness: 0.72,
            metalness: 0.02,
            transparent: true,
            opacity: 1,
          }),
        );
        const mesh = new THREE.Mesh(geo, material);
        const [lx, lz] = toWorld(lot.x + lot.w / 2, lot.y + lot.h / 2);
        const baseY = 0.1 + h / 2;
        mesh.position.set(lx, baseY, lz);

        // Emerald edging, as the flat plan draws it. Parented to the
        // mesh so it inherits the lift applied on selection.
        const edges = track(new THREE.EdgesGeometry(geo));
        const edgeLine = new THREE.LineSegments(edges, edgeMaterial);
        mesh.add(edgeLine);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = {
          code: lot.id,
          section: section.label,
          status: lot.status,
        } satisfies LotHit;
        scene.add(mesh);
        lotEntries.push({
          mesh,
          material,
          edgeLine,
          data: mesh.userData as LotHit,
          baseY,
        });
      }
    }

    // ---- boundary --------------------------------------------------
    const boundaryPoints: THREE.Vector3[] = (
      [
        [30, 40],
        [770, 40],
        [770, 460],
        [30, 460],
        [30, 40],
      ] as const
    ).map(([px, pz]) => {
      const [wx, wz] = toWorld(px, pz);
      return new THREE.Vector3(wx, 0.06, wz);
    });
    const boundaryGeo = track(
      new THREE.BufferGeometry().setFromPoints(boundaryPoints),
    );
    const boundaryMat = track(
      new THREE.LineDashedMaterial({
        color: PLAN_COLORS.gold,
        dashSize: 0.5,
        gapSize: 0.36,
      }),
    );
    const boundary = new THREE.Line(boundaryGeo, boundaryMat);
    boundary.computeLineDistances();
    scene.add(boundary);

    // ---- entrance --------------------------------------------------
    const entranceGeo = track(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 24));
    const entranceMat = track(
      new THREE.MeshStandardMaterial({
        color: PLAN_COLORS.gold,
        roughness: 0.5,
        metalness: 0.15,
      }),
    );
    const entrance = new THREE.Mesh(entranceGeo, entranceMat);
    const [ex, ez] = toWorld(395, 470);
    entrance.position.set(ex, 0.09, ez);
    entrance.castShadow = true;
    scene.add(entrance);

    // ---- selection + filter ---------------------------------------
    /**
     * Repaint the lots for the current selection and filter. Cheap
     * enough to run on every change — it only touches materials, never
     * geometry.
     */
    const applyState = (selected: string | undefined, active: string): void => {
      for (const entry of lotEntries) {
        const matches = active === "all" || entry.data.status === active;
        const isSelected = entry.data.code === selected;

        // The outline has to go with its lot. Leaving it lit while the
        // block fades turns a filtered scene into a thicket of empty
        // boxes — the filter stops answering "which ones are these?".
        entry.edgeLine.visible = matches;
        entry.material.opacity = matches ? 1 : 0.1;
        entry.material.color.set(
          isSelected ? PLAN_COLORS.moss : SURFACE_COLOR[entry.data.status],
        );
        entry.material.emissive.set(
          isSelected ? PLAN_COLORS.moss : 0x000000,
        );
        entry.material.emissiveIntensity = isSelected ? 0.35 : 0;
        entry.mesh.position.y = isSelected ? entry.baseY + 0.35 : entry.baseY;
      }
    };
    applyStateRef.current = applyState;

    // ---- picking ---------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerMovedSincePress = false;

    const setPointerFrom = (event: PointerEvent): void => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const pick = (): LotEntry | null => {
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(
        lotEntries.map((e) => e.mesh),
        false,
      );
      const first = hits[0];
      if (first === undefined) return null;
      return lotEntries.find((e) => e.mesh === first.object) ?? null;
    };

    const handlePointerDown = (): void => {
      pointerMovedSincePress = false;
    };
    const handlePointerMove = (event: PointerEvent): void => {
      pointerMovedSincePress = true;
      setPointerFrom(event);
      const entry = pick();
      renderer.domElement.style.cursor = entry ? "pointer" : "grab";
      setHovered(entry ? `${entry.data.code} · ${entry.data.status}` : null);
    };
    const handlePointerUp = (event: PointerEvent): void => {
      // A drag is a camera move, not a selection.
      if (pointerMovedSincePress) return;
      setPointerFrom(event);
      const entry = pick();
      if (entry === null) return;
      onSelectRef.current?.({
        section: entry.data.section,
        id: entry.data.code,
        status: entry.data.status,
      });
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    // ---- loop ------------------------------------------------------
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let raf = 0;
    const tick = (): void => {
      controls.update();
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(tick);
    };
    if (!reduceMotion) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.35;
    }
    tick();

    const handleResize = (): void => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(mount);

    // Stop rendering while the tab is hidden — a spinning WebGL loop in
    // a background tab is pure battery cost.
    const handleVisibility = (): void => {
      if (document.hidden) {
        window.cancelAnimationFrame(raf);
      } else {
        raf = window.requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", handleVisibility);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      controls.dispose();
      applyStateRef.current = null;
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Selection and filter are material-only updates, so they run against
  // the built scene instead of tearing it down.
  useEffect(() => {
    applyStateRef.current?.(selectedId, filter);
  }, [selectedId, filter]);

  if (failed) {
    return (
      <div
        role="status"
        className="flex min-h-[24rem] flex-col items-center justify-center gap-2 rounded border border-surface-border bg-surface-muted p-8 text-center"
      >
        <p className="font-display text-xl font-light text-text-default">
          This browser cannot show the 3D view.
        </p>
        <p className="max-w-sm text-sm text-text-muted">
          Switch back to the plan — it shows the same gardens and the same
          lots.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={mountRef}
        data-testid="cemetery-map-3d"
        role="img"
        aria-label="Three-dimensional view of the memorial park. The plan view lists every lot as text."
        className="h-[24rem] w-full overflow-hidden rounded bg-surface-emphasis sm:h-[30rem]"
      />
      <p className="pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
        {hovered ?? "Drag to turn · scroll to zoom · tap a lot"}
      </p>
    </div>
  );
}
