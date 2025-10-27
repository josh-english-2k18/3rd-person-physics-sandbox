
import React, { Suspense, useMemo, useState, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './components/Scene';
import { KeyboardControls, PointerLockControls } from '@react-three/drei';

export default function App() {
  const map = useMemo(() => [
    { name: 'forward', keys: ['ArrowUp', 'w', 'W'] },
    { name: 'backward', keys: ['ArrowDown', 's', 'S'] },
    { name: 'left', keys: ['ArrowLeft', 'a', 'A'] },
    { name: 'right', keys: ['ArrowRight', 'd', 'D'] },
  ], []);

  const [isLocked, setIsLocked] = useState(false);
  // FIX: Initialize useRef with null and provide a generic type for the controls ref to fix type errors.
  // FIX: Use `React.ElementRef<typeof PointerLockControls>` to get the correct instance type for the ref. `PointerLockControls` is a component value, not a type.
  const controlsRef = useRef<React.ElementRef<typeof PointerLockControls>>(null);

  return (
    <main className="w-screen h-screen bg-gray-900 text-white">
      {!isLocked && (
        <div 
          className="absolute inset-0 bg-black bg-opacity-50 flex justify-center items-center z-20 cursor-pointer" 
          onClick={() => controlsRef.current?.lock()}
        >
          <div className="text-center">
            <h2 className="text-4xl font-bold">Click to Play</h2>
            <p className="text-xl mt-2">Use WASD to move and Mouse to look.</p>
            <p className="text-lg mt-1">Press ESC to release cursor.</p>
          </div>
        </div>
      )}
      {isLocked && (
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-3xl font-thin pointer-events-none z-20">
          +
        </div>
      )}

      <div className="absolute top-4 left-4 z-10">
        <h1 className="text-2xl font-bold">3rd-Person Physics Sandbox</h1>
        <p className="text-gray-400">Use WASD to move the character and mouse to look.</p>
      </div>
      <KeyboardControls map={map}>
        <Canvas shadows camera={{ position: [0, 0, 0], fov: 60 }}>
          <Suspense fallback={<CanvasLoader />}>
            <Scene />
            <PointerLockControls 
              ref={controlsRef}
              onLock={() => setIsLocked(true)}
              onUnlock={() => setIsLocked(false)}
            />
          </Suspense>
        </Canvas>
      </KeyboardControls>
    </main>
  );
}

function CanvasLoader() {
    return (
        <mesh>
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial color="gray" wireframe />
        </mesh>
    );
}
