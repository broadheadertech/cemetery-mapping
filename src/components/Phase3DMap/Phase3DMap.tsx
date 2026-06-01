"use client";

/**
 * Phase3DMap — a rotatable 3D survey of a development parcel (Phase 1,
 * the Northwest Parcel: Gardens of Grace, Faith & Hope).
 *
 * This is the "3D survey review" step of the phase-mapping playbook
 * (Step 05 in `/phase-planning`) and the Phase-2 map renderer ADR-0008
 * slates. The heavy Three.js scene is built imperatively inside a single
 * mount effect (WebGL has no React reconciler); the surrounding chrome —
 * filter chips, view controls, legend, the selected-lot rail and the
 * per-section roll-up — is ordinary React driven by `useState`. The
 * effect bridges the two via callbacks (`onSelect`, `onRollup`) and an
 * imperative handle (`apiRef`) the chrome calls into.
 *
 * Loaded with `ssr: false` from the route — Three.js + WebGL are
 * browser-only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type LotStatus =
  | "available"
  | "reserved"
  | "sold"
  | "occupied"
  | "defaulted";

interface LotUserData {
  id: string;
  code: string;
  status: LotStatus;
  type: "single" | "family" | "mausoleum";
  section: string;
  sectionCode: string;
  price: number;
  occupant: string | null;
  block: string;
}

interface SectionRollup {
  name: string;
  percent: number;
  count: number;
}

interface Rollup {
  total: number;
  available: number;
  occupiedPercent: number;
  sections: SectionRollup[];
}

interface MapApi {
  applyFilter: (filter: string) => void;
  resetView: () => void;
  setAutoRotate: (on: boolean) => void;
  focusSection: (index: number) => void;
}

const STATUS: Record<LotStatus, { color: number; stone: boolean }> = {
  available: { color: 0x9bbf8f, stone: false },
  reserved: { color: 0xd9a441, stone: true },
  sold: { color: 0x94a3b8, stone: true },
  occupied: { color: 0x2f4f43, stone: true },
  defaulted: { color: 0xcf5b5b, stone: true },
};

const LEGEND: ReadonlyArray<{ label: string; color: string }> = [
  { label: "Available", color: "#9bbf8f" },
  { label: "Reserved", color: "#d9a441" },
  { label: "Sold", color: "#94a3b8" },
  { label: "Occupied", color: "#2f4f43" },
  { label: "Defaulted", color: "#cf5b5b" },
];

const FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "occupied", label: "Occupied" },
  { value: "defaulted", label: "Defaulted" },
];

const OCC = [
  "Maria S. Reyes",
  "Ernesto Cruz",
  "Lucia Mendoza",
  "Roberto Lim",
  "Adela Santos",
  "Jose Magbanua",
  "Teresa Ramos",
  "Pedro Bautista",
  "Carmen Diaz",
  "Anita Flores",
];

const peso = (n: number) => "₱" + n.toLocaleString("en-PH");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const PILL_TINT: Record<LotStatus, string> = {
  available: "bg-status-available-bg text-status-available-text",
  reserved: "bg-status-reserved-bg text-status-reserved-text",
  sold: "bg-status-sold-bg text-status-sold-text",
  occupied: "bg-status-occupied-bg text-status-occupied-text",
  defaulted: "bg-status-defaulted-bg text-status-defaulted-text",
};

export default function Phase3DMap() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<MapApi | null>(null);

  const [selected, setSelected] = useState<LotUserData | null>(null);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [autoRotate, setAutoRotate] = useState(false);
  const [hint, setHint] = useState(
    "Drag to orbit · scroll to zoom · click a lot to inspect",
  );
  const [ready, setReady] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Build the scene once on mount. ----
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf6f2ea);
    scene.fog = new THREE.Fog(0xf6f2ea, 110, 240);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
    const CAM0 = new THREE.Vector3(0, 40, 56);
    camera.position.copy(CAM0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 18;
    controls.maxDistance = 110;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.target.set(0, 1, 0);
    controls.autoRotateSpeed = 0.6;

    scene.add(new THREE.HemisphereLight(0xfbf6ea, 0x6f8f6a, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2da, 1.05);
    sun.position.set(34, 46, 24);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -66;
    sun.shadow.camera.right = 66;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 160;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshStandardMaterial({ color: 0x7e9a70, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(200, 100, 0xc9a96b, 0xc9a96b);
    const gridMat = grid.material as THREE.Material;
    gridMat.opacity = 0.06;
    gridMat.transparent = true;
    grid.position.y = 0.02;
    scene.add(grid);

    const matCache: Record<number, THREE.MeshStandardMaterial> = {};
    const statMat = (c: number) => {
      if (!matCache[c])
        matCache[c] = new THREE.MeshStandardMaterial({
          color: c,
          roughness: 0.75,
          metalness: 0.02,
        });
      return matCache[c];
    };
    const concrete = new THREE.MeshStandardMaterial({
      color: 0xe7dfce,
      roughness: 0.95,
    });
    const pathMat = new THREE.MeshStandardMaterial({
      color: 0xd2c9b2,
      roughness: 1,
    });
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0xc9a96b,
      roughness: 0.6,
      metalness: 0.1,
    });

    const rand = (i: number) => {
      const x = Math.sin(i * 43.17 + 7.3) * 10000;
      return x - Math.floor(x);
    };
    const pickStatus = (i: number): LotStatus => {
      const r = rand(i);
      if (r < 0.06) return "available";
      if (r < 0.12) return "reserved";
      if (r < 0.21) return "sold";
      if (r < 0.28) return "defaulted";
      return "occupied";
    };

    interface SectionDef {
      id: string;
      code: string;
      name: string;
      cols: number;
      rows: number;
      tint: number;
      mausoleum?: boolean;
      w: number;
      d: number;
      cx: number;
    }
    const SECTIONS: SectionDef[] = [
      { id: "A", code: "GRACE", name: "Garden of Grace", cols: 5, rows: 5, tint: 0x8fab7f, w: 0, d: 0, cx: 0 },
      { id: "B", code: "FAITH", name: "Garden of Faith", cols: 6, rows: 5, tint: 0x86a276, mausoleum: true, w: 0, d: 0, cx: 0 },
      { id: "C", code: "HOPE", name: "Garden of Hope", cols: 5, rows: 5, tint: 0x93ad84, w: 0, d: 0, cx: 0 },
    ];
    const cellW = 3.0;
    const cellD = 3.6;
    const avenue = 6;

    SECTIONS.forEach((s) => {
      s.w = s.cols * cellW;
      s.d = s.rows * cellD;
    });
    const totalW =
      SECTIONS.reduce((a, s) => a + s.w, 0) + avenue * (SECTIONS.length - 1);
    let cursorX = -totalW / 2;
    SECTIONS.forEach((s) => {
      s.cx = cursorX + s.w / 2;
      cursorX += s.w + avenue;
    });

    const lots: THREE.Group[] = [];
    const labelEls: { el: HTMLDivElement; sec: SectionDef }[] = [];
    let gid = 0;

    SECTIONS.forEach((sec) => {
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(sec.w + 2.4, 0.06, sec.d + 2.4),
        new THREE.MeshStandardMaterial({ color: sec.tint, roughness: 1 }),
      );
      pad.position.set(sec.cx, 0.04, 0);
      pad.receiveShadow = true;
      scene.add(pad);

      const bx = sec.w / 2 + 1.4;
      const bz = sec.d / 2 + 1.4;
      (
        [
          [0, -bz, 2 * bx, 0.4],
          [0, bz, 2 * bx, 0.4],
          [-bx, 0, 0.4, 2 * bz + 0.4],
          [bx, 0, 0.4, 2 * bz + 0.4],
        ] as Array<[number, number, number, number]>
      ).forEach(([x, z, w, d]) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), curbMat);
        m.position.set(sec.cx + x, 0.2, z);
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
      });

      const x0 = -sec.w / 2 + cellW / 2;
      const z0 = -sec.d / 2 + cellD / 2;
      for (let r = 0; r < sec.rows; r++) {
        for (let c = 0; c < sec.cols; c++) {
          gid++;
          const st = pickStatus(gid + sec.id.charCodeAt(0) * 13);
          const cfg = STATUS[st];
          const isMaus = Boolean(sec.mausoleum) && r === 0 && c % 3 !== 1;
          const type: LotUserData["type"] = isMaus
            ? "mausoleum"
            : c % 3 === 0
              ? "family"
              : "single";
          const x = sec.cx + x0 + c * cellW;
          const z = z0 + r * cellD;
          const g = new THREE.Group();
          g.position.set(x, 0, z);

          const baseW = type === "family" ? 2.6 : 2.1;
          const baseD = type === "family" ? 3.0 : 2.6;
          const base = new THREE.Mesh(
            new THREE.BoxGeometry(baseW, 0.3, baseD),
            concrete,
          );
          base.position.y = 0.15;
          base.castShadow = true;
          base.receiveShadow = true;
          g.add(base);
          const inset = new THREE.Mesh(
            new THREE.BoxGeometry(baseW - 0.5, 0.06, baseD - 0.5),
            cfg.stone ? statMat(0xcdbfa6) : statMat(sec.tint),
          );
          inset.position.y = 0.33;
          inset.receiveShadow = true;
          g.add(inset);

          if (isMaus) {
            const h = 3.0 + rand(gid) * 1.1;
            const wall = new THREE.Mesh(
              new THREE.BoxGeometry(baseW - 0.2, h, baseD - 0.4),
              statMat(cfg.color),
            );
            wall.position.y = 0.3 + h / 2;
            wall.castShadow = true;
            wall.receiveShadow = true;
            g.add(wall);
            const roof = new THREE.Mesh(
              new THREE.ConeGeometry(baseW * 0.78, 0.85, 4),
              statMat(0x144437),
            );
            roof.rotation.y = Math.PI / 4;
            roof.position.y = 0.3 + h + 0.42;
            roof.castShadow = true;
            g.add(roof);
            const fin = new THREE.Mesh(
              new THREE.BoxGeometry(0.1, 0.6, 0.1),
              statMat(0xc9a96b),
            );
            fin.position.y = 0.3 + h + 1.0;
            g.add(fin);
          } else if (cfg.stone) {
            const w2 = baseW - 0.7;
            const hs = new THREE.Mesh(
              new THREE.BoxGeometry(w2, 1.2, 0.32),
              statMat(cfg.color),
            );
            hs.position.set(0, 0.3 + 0.6, -baseD / 2 + 0.35);
            hs.castShadow = true;
            hs.receiveShadow = true;
            g.add(hs);
            const capMesh = new THREE.Mesh(
              new THREE.CylinderGeometry(w2 / 2, w2 / 2, 0.32, 14, 1, false, 0, Math.PI),
              statMat(cfg.color),
            );
            capMesh.rotation.z = Math.PI / 2;
            capMesh.rotation.y = Math.PI / 2;
            capMesh.position.set(0, 0.3 + 1.2, -baseD / 2 + 0.35);
            capMesh.castShadow = true;
            g.add(capMesh);
          } else {
            const stake = new THREE.Mesh(
              new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8),
              statMat(0x4a8270),
            );
            stake.position.set(baseW / 2 - 0.25, 0.6, -baseD / 2 + 0.25);
            g.add(stake);
            const flag = new THREE.Mesh(
              new THREE.BoxGeometry(0.4, 0.26, 0.02),
              statMat(0x9bbf8f),
            );
            flag.position.set(baseW / 2 - 0.05, 0.8, -baseD / 2 + 0.25);
            g.add(flag);
          }

          const code = `${sec.id}-${100 + r * sec.cols + c + 1}`;
          const userData: LotUserData = {
            id: "lot" + gid,
            code,
            status: st,
            type,
            section: sec.name,
            sectionCode: sec.code,
            price:
              type === "mausoleum" ? 1350000 : type === "family" ? 340000 : 88000,
            occupant:
              cfg.stone && st === "occupied"
                ? (OCC[gid % OCC.length] ?? null)
                : null,
            block: `${sec.id}${r + 1}`,
          };
          g.userData = userData;
          scene.add(g);
          lots.push(g);
        }
      }

      const el = document.createElement("div");
      el.className = "phase3d-seclabel";
      const cnt = lots.filter(
        (l) => (l.userData as LotUserData).sectionCode === sec.code,
      );
      const avail = cnt.filter(
        (l) => (l.userData as LotUserData).status === "available",
      ).length;
      el.innerHTML = `<span class="sn">${sec.name}</span><span class="sc">${cnt.length} LOTS · ${avail} OPEN</span>`;
      stage.appendChild(el);
      labelEls.push({ el, sec });
    });

    // Avenues + promenade.
    const parcelD = Math.max(...SECTIONS.map((s) => s.d)) + 5;
    for (let i = 0; i < SECTIONS.length - 1; i++) {
      const a = SECTIONS[i];
      const b = SECTIONS[i + 1];
      if (!a || !b) continue;
      const xMid = (a.cx + a.w / 2 + b.cx - b.w / 2) / 2;
      const p = new THREE.Mesh(
        new THREE.BoxGeometry(avenue - 1.2, 0.08, parcelD),
        pathMat,
      );
      p.position.set(xMid, 0.05, 0);
      p.receiveShadow = true;
      scene.add(p);
    }
    const prom = new THREE.Mesh(
      new THREE.BoxGeometry(totalW + 10, 0.08, 2),
      pathMat,
    );
    prom.position.set(0, 0.05, parcelD / 2 + 2.5);
    prom.receiveShadow = true;
    scene.add(prom);

    // Trees along the parcel edges.
    const tree = (x: number, z: number) => {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.26, 1.6, 7),
        new THREE.MeshStandardMaterial({ color: 0x6b5640, roughness: 1 }),
      );
      trunk.position.y = 0.8;
      trunk.castShadow = true;
      g.add(trunk);
      const fMat = new THREE.MeshStandardMaterial({ color: 0x3f7a5c, roughness: 1 });
      for (let i = 0; i < 3; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(1.1 - i * 0.18, 8, 7), fMat);
        f.position.y = 2 + i * 0.7;
        f.position.x = (rand(i + x) - 0.5) * 0.5;
        f.castShadow = true;
        g.add(f);
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(0.9 + rand(x * z + 1) * 0.5);
      scene.add(g);
    };
    const edge = parcelD / 2 + 3.5;
    for (let i = 0; i < 7; i++) {
      const x = -totalW / 2 - 3 + (i * (totalW + 6)) / 6;
      tree(x, -edge);
      tree(x, edge);
    }

    // Gate / chapel.
    {
      const g = new THREE.Group();
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(5, 3.4, 4),
        new THREE.MeshStandardMaterial({ color: 0x1d5c4d, roughness: 0.7 }),
      );
      wall.position.y = 1.7;
      wall.castShadow = true;
      wall.receiveShadow = true;
      g.add(wall);
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(3.7, 1.8, 4),
        new THREE.MeshStandardMaterial({ color: 0x144437, roughness: 0.7 }),
      );
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 4.3;
      roof.castShadow = true;
      g.add(roof);
      const cv = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16), curbMat);
      cv.position.y = 6;
      g.add(cv);
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.16), curbMat);
      ch.position.y = 6.15;
      g.add(ch);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, 2, 0.1),
        new THREE.MeshStandardMaterial({ color: 0xc9a96b, roughness: 0.5 }),
      );
      door.position.set(0, 1, 2.01);
      g.add(door);
      g.position.set(0, 0, parcelD / 2 + 7);
      scene.add(g);
    }

    // Selection ring.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.1, 0.09, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0xc9a96b }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.visible = false;
    scene.add(ring);

    // Interaction.
    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let selectedLot: THREE.Group | null = null;
    let currentFilter = "all";
    const findLot = (o: THREE.Object3D | null): THREE.Group | null => {
      let cur: THREE.Object3D | null = o;
      while (cur) {
        if (cur.userData && (cur.userData as LotUserData).code)
          return cur as THREE.Group;
        cur = cur.parent;
      }
      return null;
    };
    const setPointer = (e: PointerEvent | MouseEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    const onPointerMove = (e: PointerEvent) => {
      setPointer(e);
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(lots, true)[0];
      renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    };
    const onPointerDown = () => {
      renderer.domElement.style.cursor = "grabbing";
    };
    const onClick = (e: MouseEvent) => {
      setPointer(e);
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(lots, true)[0];
      if (hit) {
        const lot = findLot(hit.object);
        const u = lot?.userData as LotUserData | undefined;
        if (lot && u && (currentFilter === "all" || u.status === currentFilter)) {
          selectLot(lot);
        }
      }
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("click", onClick);

    function selectLot(lot: THREE.Group) {
      selectedLot = lot;
      const u = lot.userData as LotUserData;
      ring.visible = true;
      ring.position.set(lot.position.x, 0.1, lot.position.z);
      setSelected({ ...u });
    }

    const applyFilter = (f: string) => {
      currentFilter = f;
      lots.forEach((g) => {
        const u = g.userData as LotUserData;
        const show = f === "all" || u.status === f;
        g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            const mat = mesh.material as THREE.Material;
            mat.transparent = !show;
            mat.opacity = show ? 1 : 0.1;
          }
        });
      });
      const u = selectedLot?.userData as LotUserData | undefined;
      ring.visible = Boolean(
        selectedLot && u && (f === "all" || u.status === f),
      );
    };

    // Camera focus / reset.
    let camTarget: THREE.Vector3 | null = null;
    let tgtTarget: THREE.Vector3 | null = null;
    const focusSection = (index: number) => {
      const sec = SECTIONS[index];
      if (!sec) return;
      camTarget = new THREE.Vector3(sec.cx, 22, sec.d / 2 + 22);
      tgtTarget = new THREE.Vector3(sec.cx, 1, 0);
    };
    const resetView = () => {
      camTarget = CAM0.clone();
      tgtTarget = new THREE.Vector3(0, 1, 0);
    };

    apiRef.current = {
      applyFilter,
      resetView,
      setAutoRotate: (on: boolean) => {
        controls.autoRotate = on;
      },
      focusSection,
    };

    // Roll-up stats (computed once).
    {
      const total = lots.length;
      const avail = lots.filter(
        (l) => (l.userData as LotUserData).status === "available",
      ).length;
      const occ = lots.filter(
        (l) => (l.userData as LotUserData).status === "occupied",
      ).length;
      const sections: SectionRollup[] = SECTIONS.map((sec) => {
        const c = lots.filter(
          (l) => (l.userData as LotUserData).sectionCode === sec.code,
        );
        const oc = c.filter((l) => {
          const s = (l.userData as LotUserData).status;
          return s === "occupied" || s === "sold";
        }).length;
        return {
          name: sec.name,
          percent: c.length > 0 ? Math.round((oc / c.length) * 100) : 0,
          count: c.length,
        };
      });
      setRollup({
        total,
        available: avail,
        occupiedPercent: total > 0 ? Math.round((occ / total) * 100) : 0,
        sections,
      });
    }

    // Resize (robust against 0×0 pre-layout reads).
    const resize = () => {
      const w = stage.clientWidth || stage.offsetWidth;
      const h = stage.clientHeight || stage.offsetHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", resize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(stage);
    }
    requestAnimationFrame(resize);
    resize();

    // Project the DOM section labels each frame.
    const _v = new THREE.Vector3();
    const updateLabels = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      labelEls.forEach(({ el, sec }) => {
        _v.set(sec.cx, 5.5, -sec.d / 2 - 2);
        _v.project(camera);
        const behind = _v.z > 1;
        el.style.opacity = behind ? "0" : "1";
        el.style.left = (_v.x * 0.5 + 0.5) * w + "px";
        el.style.top = (-_v.y * 0.5 + 0.5) * h + "px";
      });
    };

    let raf = 0;
    let pulse = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      lots.forEach((g) => {
        const t = g === selectedLot ? 0.5 : 0;
        g.position.y += (t - g.position.y) * 0.18;
      });
      if (camTarget && tgtTarget) {
        camera.position.lerp(camTarget, 0.08);
        controls.target.lerp(tgtTarget, 0.08);
        if (camera.position.distanceTo(camTarget) < 0.5) camTarget = null;
      }
      if (ring.visible && selectedLot) {
        pulse += 0.05;
        ring.position.y = 0.1 + Math.sin(pulse) * 0.05 + selectedLot.position.y;
        ring.scale.setScalar(1 + Math.sin(pulse) * 0.03);
      }
      if (renderer.domElement.width === 0 || renderer.domElement.height === 0)
        resize();
      controls.update();
      updateLabels();
      renderer.render(scene, camera);
    };

    // Open with the first available lot selected.
    const initial =
      lots.find((l) => (l.userData as LotUserData).status === "available") ??
      lots[0];
    if (initial) selectLot(initial);
    setReady(true);
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      if (ro) ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      labelEls.forEach(({ el }) => el.remove());
      if (renderer.domElement.parentNode === stage) {
        stage.removeChild(renderer.domElement);
      }
      apiRef.current = null;
    };
  }, []);

  // Bridge filter state → scene.
  useEffect(() => {
    apiRef.current?.applyFilter(filter);
  }, [filter]);

  // Bridge auto-rotate toggle → controls.
  useEffect(() => {
    apiRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  const onPhaseClick = useCallback((phase: number) => {
    if (phase !== 1) {
      setHint(`Phase ${phase} — GPS survey scheduled; 3D mesh not yet captured`);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(
        () => setHint("Drag to orbit · scroll to zoom · click a lot to inspect"),
        3200,
      );
      return;
    }
    apiRef.current?.resetView();
  }, []);

  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  const dims =
    selected?.type === "family"
      ? "4.0 m × 2.4 m"
      : selected?.type === "mausoleum"
        ? "6.0 m × 4.0 m"
        : "1.0 m × 2.4 m";
  const capacity =
    selected?.type === "family"
      ? "6 interments"
      : selected?.type === "mausoleum"
        ? "12 crypts"
        : "1 interment";

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-surface-border bg-surface-base shadow-[var(--shadow-card)] lg:grid-cols-[1fr_360px]">
      {/* Stage */}
      <div className="relative h-[60vh] min-h-[460px] bg-surface-emphasis lg:h-[70vh]">
        <div ref={stageRef} className="absolute inset-0" />

        {/* Filter toolbar */}
        <div className="absolute left-4 top-4 flex max-w-[560px] flex-wrap gap-1.5 rounded-lg border border-surface-border bg-surface-base/95 p-1.5 shadow-[var(--shadow-card)] backdrop-blur">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={[
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                filter === f.value
                  ? "bg-primary text-primary-fg"
                  : "text-text-muted hover:bg-surface-emphasis hover:text-primary",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* View controls + phase switcher */}
        <div className="absolute right-4 top-4 flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-surface-border bg-surface-base/95 shadow-[var(--shadow-card)]">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onPhaseClick(n)}
                className={[
                  "px-3 py-2 font-mono text-[11px] font-semibold tracking-wide transition-colors",
                  n === 1
                    ? "bg-accent-gold text-primary-hover"
                    : "text-text-muted hover:text-primary",
                ].join(" ")}
              >
                PHASE {n}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            aria-pressed={autoRotate}
            title="Auto-rotate"
            className={[
              "flex h-10 w-10 items-center justify-center rounded-md border shadow-[var(--shadow-card)] transition-colors",
              autoRotate
                ? "border-primary bg-primary text-primary-fg"
                : "border-surface-border bg-surface-base/95 text-text-default hover:text-primary",
            ].join(" ")}
          >
            <RotateIcon />
          </button>
          <button
            type="button"
            onClick={() => apiRef.current?.resetView()}
            title="Reset view"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-surface-border bg-surface-base/95 text-text-default shadow-[var(--shadow-card)] transition-colors hover:text-primary"
          >
            <ResetIcon />
          </button>
        </div>

        {/* Legend */}
        <div className="absolute bottom-4 left-4 rounded-lg border border-surface-border bg-surface-base/95 px-4 py-3 shadow-[var(--shadow-card)]">
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-text-muted">
            Lot status
          </div>
          {LEGEND.map((l) => (
            <div key={l.label} className="my-1 flex items-center gap-2 text-xs text-text-default">
              <span
                className="h-3 w-3 rounded-[3px]"
                style={{ background: l.color }}
              />
              {l.label}
            </div>
          ))}
        </div>

        {/* Hint */}
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-surface-border bg-surface-muted/90 px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-wide text-text-muted">
          {hint}
        </div>

        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-emphasis">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-surface-border border-t-primary" />
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted">
              Building 3D survey…
            </span>
          </div>
        )}
      </div>

      {/* Rail */}
      <aside className="overflow-y-auto border-t border-surface-border p-6 lg:border-l lg:border-t-0">
        {selected ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
              {selected.section} · Block {selected.block}
            </div>
            <div className="mt-2.5 font-display text-4xl font-semibold leading-none text-text-default">
              Lot {selected.code}
            </div>
            <hr className="my-4 border-0 border-t border-accent-gold opacity-60" />
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${PILL_TINT[selected.status]}`}
            >
              {selected.status}
            </span>

            <dl className="mt-5 grid grid-cols-2">
              <Fact label="Type" value={cap(selected.type)} />
              <Fact label="Status" value={cap(selected.status)} />
              <Fact label="Dimensions" value={dims} />
              <Fact label="Capacity" value={capacity} />
              <Fact label="Base price" value={peso(selected.price)} />
              <Fact label="GPS" value="14.06° N" />
            </dl>

            {selected.occupant && (
              <div className="mt-5 rounded-lg border border-surface-border bg-surface-muted p-4 text-center">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  Resting here
                </div>
                <div className="mt-1 font-display text-xl font-semibold text-text-default">
                  {selected.occupant}
                </div>
                <div className="mt-0.5 font-mono text-xs text-text-muted">
                  1947 — 2024
                </div>
              </div>
            )}

            <div className="mt-5 space-y-2.5">
              {selected.status === "available" && (
                <Link
                  href="/sales/new"
                  className={`${btnPrimary} w-full justify-center`}
                >
                  Start a sale
                </Link>
              )}
              <Link href="/lots" className={`${btnOutline} w-full justify-center`}>
                Open full record
              </Link>
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted">
            Click a lot in the 3D view to inspect it.
          </p>
        )}

        {/* Phase roll-up */}
        <div className="mt-7 border-t border-surface-emphasis pt-4.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
            Development phase
          </div>
          <div className="mt-1.5 font-display text-2xl font-semibold text-text-default">
            Phase 1 · Northwest Parcel
          </div>
          <div className="mt-3.5 flex border-y border-surface-emphasis">
            <Stat value={rollup ? String(rollup.total) : "—"} label="Lots" />
            <Stat value={rollup ? String(rollup.available) : "—"} label="Available" />
            <Stat
              value={rollup ? `${rollup.occupiedPercent}%` : "—"}
              label="Occupied"
            />
            <Stat value="3" label="Sections" last />
          </div>
          <div className="mt-4 flex flex-col gap-0.5">
            {rollup?.sections.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onClick={() => apiRef.current?.focusSection(i)}
                className="flex items-center gap-2.5 rounded-md px-1 py-2 text-left transition-colors hover:bg-surface-muted"
              >
                <span className="flex-1 text-[13.5px] font-semibold text-text-default">
                  {s.name}
                </span>
                <span className="h-1.5 w-[88px] overflow-hidden rounded-full bg-surface-emphasis">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${s.percent}%` }}
                  />
                </span>
                <span className="min-w-[62px] text-right font-mono text-[11px] text-text-muted">
                  {s.percent}% · {s.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-surface-emphasis py-3 [&:nth-child(-n+2)]:border-t-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
        {label}
      </dt>
      <dd className="mt-1 text-[15px] font-medium text-text-default">{value}</dd>
    </div>
  );
}

function Stat({
  value,
  label,
  last = false,
}: {
  value: string;
  label: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex-1 py-3.5 text-center ${last ? "" : "border-r border-surface-emphasis"}`}
    >
      <div className="font-display text-2xl font-semibold text-primary">{value}</div>
      <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
    </div>
  );
}

function RotateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-9 9z" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const btnBase =
  "inline-flex min-h-[44px] items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2";
const btnPrimary = `${btnBase} bg-primary text-primary-fg hover:bg-primary-hover`;
const btnOutline = `${btnBase} border border-surface-border bg-surface-base text-text-default hover:border-accent-gold hover:text-primary`;
