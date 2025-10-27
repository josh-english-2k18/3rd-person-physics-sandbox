import React from 'react';
import { 
  Cone, 
  Box, 
  Sphere,
  Grid,
  GizmoHelper,
  GizmoViewport 
} from '@react-three/drei';
import { Physics, RigidBody, CuboidCollider } from '@react-three/rapier';
import { Color } from 'three';
import { Player } from './Player';

// Component for the ground plane
const Ground = () => {
  return (
    <RigidBody type="fixed" colliders={false} restitution={0.5}>
      <CuboidCollider args={[500, 0.1, 500]} position={[0, -0.1, 0]} />
      {/* Visual plane to receive shadows */}
      <mesh receiveShadow position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1000, 1000]} />
        <meshStandardMaterial color="#303030" />
      </mesh>
      {/* Grid helper for tiled look */}
      <Grid 
        position={[0, 0, 0]} 
        args={[1000, 1000]} 
        infiniteGrid={false}
        sectionColor={new Color(0x505050)}
        cellColor={new Color(0x2c2c2c)}
        fadeDistance={100}
      />
    </RigidBody>
  );
};

// Component for the falling shapes
const STACK_DIMENSIONS = { width: 5, height: 5 };
const STACK_SPACING = 1;
const STACK_START = { x: -2, y: 0.5, z: 5 };

const Shapes = () => {
  const shapes = React.useMemo(() => {
    const items = [];
    const count = 10;
    const area = 40; // spawn in a 40x40 area

    // Cones
    for (let i = 0; i < count; i++) {
      items.push(
        <RigidBody key={`cone_${i}`} position={[ (Math.random() - 0.5) * area, 10 + Math.random() * 10, (Math.random() - 0.5) * area ]} restitution={0.6}>
          <Cone args={[0.7, 1, 32]} castShadow>
            <meshStandardMaterial color="red" roughness={0.3} metalness={0.5} />
          </Cone>
        </RigidBody>
      );
    }

    // Cubes
    for (let i = 0; i < count; i++) {
      items.push(
        <RigidBody key={`cube_${i}`} position={[ (Math.random() - 0.5) * area, 10 + Math.random() * 10, (Math.random() - 0.5) * area ]} restitution={0.7}>
          <Box args={[1, 1, 1]} castShadow>
            <meshStandardMaterial color="blue" roughness={0.2} metalness={0.6} />
          </Box>
        </RigidBody>
      );
    }

    // Spheres
    for (let i = 0; i < count; i++) {
      items.push(
        <RigidBody key={`sphere_${i}`} position={[ (Math.random() - 0.5) * area, 10 + Math.random() * 10, (Math.random() - 0.5) * area ]} restitution={0.8}>
          <Sphere args={[0.6, 32, 32]} castShadow>
            <meshStandardMaterial color="green" roughness={0.1} metalness={0.4} />
          </Sphere>
        </RigidBody>
      );
    }

    for (let y = 0; y < STACK_DIMENSIONS.height; y++) {
      for (let x = 0; x < STACK_DIMENSIONS.width; x++) {
        items.push(
          <RigidBody key={`stack_${x}_${y}`} position={[
            STACK_START.x + x * STACK_SPACING,
            STACK_START.y + y * STACK_SPACING,
            STACK_START.z
          ]} type="dynamic" friction={0.5} restitution={0.2}>
            <Box args={[1, 1, 1]} castShadow receiveShadow>
              <meshStandardMaterial color="#1d4ed8" roughness={0.35} metalness={0.1} />
            </Box>
          </RigidBody>
        );
      }
    }

    return items;
  }, []);

  return <>{shapes}</>;
};

// Main Scene Component
export default function Scene() {
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.8} />
      <directionalLight 
        castShadow 
        position={[10, 30, 10]} 
        intensity={2.5} 
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={100}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
      />
      <hemisphereLight intensity={0.5} groundColor="black" />

      {/* Physics World */}
      <Physics gravity={[0, -9.81, 0]}>
        <Ground />
        <Shapes />
        <Player />
      </Physics>

      {/* Professional XYZ Axis Gizmo */}
      <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
        <GizmoViewport axisColors={['#ff2060', '#20ff60', '#2060ff']} labelColor="white" />
      </GizmoHelper>
    </>
  );
}
