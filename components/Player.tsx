
import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { useGLTF, useAnimations, useKeyboardControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { RigidBody, CapsuleCollider } from '@react-three/rapier';
import * as THREE from 'three';

// Constants for player movement
const MOVE_SPEED = 5;
// Preserve original remote soldier asset for optional future use.
const SOLDIER_MODEL_URL = 'https://rawcdn.githack.com/mrdoob/three.js/r129/examples/models/gltf/Soldier.glb';
const LOCAL_SOLDIER_MODEL_URL = new URL('../models/soldier/Soldier.glb', import.meta.url).href;
const PLAYER_MODEL_URL = LOCAL_SOLDIER_MODEL_URL;
const PLAYER_MODEL_Y_ROTATION = 0;
const ASSAULT_RIFLE_MODEL_URL = new URL('../models/compact_assault_rifle.glb', import.meta.url).href;
const WEAPON_NAME = 'Compact Assault Rifle';
const WEAPON_SCALE = 0.006;
const WEAPON_HAND_OFFSET = new THREE.Vector3(0.18, -0.1, -0.26);
const WEAPON_HAND_ROTATION = new THREE.Euler(-Math.PI / 2, -Math.PI / 2, Math.PI / 9);

// Reusable vectors to avoid creating new ones in the loop
const moveDirection = new THREE.Vector3();
const forwardVector = new THREE.Vector3();
const sideVector = new THREE.Vector3();
const playerWorldPos = new THREE.Vector3();
const cameraWorldQuat = new THREE.Quaternion();
const desiredCameraPos = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const rightVector = new THREE.Vector3();

export function Player() {
  // FIX: Initialize useRef with null and provide the correct type for the RigidBody ref.
  // FIX: Use `React.ElementRef<typeof RigidBody>` to get the correct instance type for the ref. `RigidBody` is a component value, not a type.
  const rigidBodyRef = useRef<React.ElementRef<typeof RigidBody>>(null);
  // FIX: Initialize useRef with null and provide the correct type for the Group ref.
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();

  // Load model and animations from local assets
  const { scene, animations } = useGLTF(PLAYER_MODEL_URL);
  const { scene: rifleScene } = useGLTF(ASSAULT_RIFLE_MODEL_URL);
  // FIX: The `group` ref is now correctly typed, satisfying useAnimations.
  const { actions } = useAnimations(animations, group);

  const animationNames = useMemo(
    () => animations.map((clip) => clip.name ?? '').filter(Boolean),
    [animations]
  );

  const idleActionName = useMemo(() => {
    return animationNames.find((name) => /idle/i.test(name)) ?? animationNames[0] ?? null;
  }, [animationNames]);

  const locomotionActionName = useMemo(() => {
    return (
      animationNames.find((name) => /walk|run|move|locomotion/i.test(name)) ??
      idleActionName
    );
  }, [animationNames, idleActionName]);

  const getAction = useCallback(
    (logicalName: 'Idle' | 'Walk') => {
      const resolvedName = logicalName === 'Idle' ? idleActionName : locomotionActionName;
      return resolvedName ? actions?.[resolvedName] : undefined;
    },
    [actions, idleActionName, locomotionActionName]
  );

  const [, getKeys] = useKeyboardControls();
  const currentAction = useRef('Idle');

  const rifle = useMemo(() => {
    const clone = rifleScene.clone(true);
    clone.name = WEAPON_NAME;
    const bounds = new THREE.Box3().setFromObject(clone);
    const center = bounds.getCenter(new THREE.Vector3());
    clone.position.sub(center);
    clone.traverse((obj) => {
      if ('matrixAutoUpdate' in obj) {
        obj.matrixAutoUpdate = true;
      }
      if ('frustumCulled' in obj) {
        obj.frustumCulled = false;
      }
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    clone.scale.setScalar(WEAPON_SCALE);
    clone.updateMatrixWorld(true);
    return clone;
  }, [rifleScene]);

  // Setup model and default animation
  useEffect(() => {
    const idleAction = getAction('Idle');
    idleAction?.reset().fadeIn(0.2).play();
    scene.traverse((obj) => {
      // FIX: Use `instanceof THREE.Mesh` for a safe type check before accessing mesh-specific properties.
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
      }
    });
    scene.rotation.y = PLAYER_MODEL_Y_ROTATION;
    return () => {
      idleAction?.fadeOut(0.1);
    };
  }, [getAction, scene]);

  useEffect(() => {
    const soldierRoot = group.current;
    if (!soldierRoot || !rifle) return;
    const rightHand = soldierRoot.getObjectByName('mixamorig:RightHand');
    if (!rightHand) return;
    rightHand.add(rifle);
    rifle.position.copy(WEAPON_HAND_OFFSET);
    rifle.rotation.copy(WEAPON_HAND_ROTATION);
    rifle.scale.setScalar(WEAPON_SCALE);
    rifle.updateMatrixWorld(true);
    return () => {
      rightHand.remove(rifle);
    };
  }, [group, rifle]);

  // Main logic loop for camera, movement, and animations
  useFrame((_, delta) => {
    if (!rigidBodyRef.current) return;

    // Force update the camera's matrix to get the latest rotation from PointerLockControls
    camera.updateMatrixWorld();

    const { forward, backward, left, right } = getKeys();
    const linvel = rigidBodyRef.current.linvel();

    // --- Player Rotation ---
    // The player should face where the camera is looking.
    // We only care about rotation around the Y axis (yaw).
    camera.getWorldQuaternion(cameraWorldQuat);
    const euler = new THREE.Euler().setFromQuaternion(cameraWorldQuat, 'YXZ');
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.y);
    rigidBodyRef.current.setRotation(yaw, true);

    // --- Movement ---
    forwardVector.set(0, 0, -1).applyQuaternion(cameraWorldQuat);
    forwardVector.y = 0; // Project onto XZ plane
    forwardVector.normalize();

    sideVector.set(1, 0, 0).applyQuaternion(cameraWorldQuat);
    sideVector.y = 0; // Project onto XZ plane
    sideVector.normalize();
    
    moveDirection.set(0, 0, 0);

    if (forward) {
      moveDirection.add(forwardVector);
    }
    if (backward) {
      moveDirection.sub(forwardVector);
    }
    if (left) {
      moveDirection.sub(sideVector); // Strafe left
    }
    if (right) {
      moveDirection.add(sideVector); // Strafe right
    }

    moveDirection.normalize().multiplyScalar(MOVE_SPEED);
    rigidBodyRef.current.setLinvel({ x: moveDirection.x, y: linvel.y, z: moveDirection.z }, true);

    // --- Animation ---
    const isMoving = forward || backward || left || right;
    const newActionName = isMoving ? 'Walk' : 'Idle';

    if (currentAction.current !== newActionName) {
      const oldAction = getAction(currentAction.current as 'Idle' | 'Walk');
      const newAction = getAction(newActionName);
      if (newAction && oldAction !== newAction) {
        oldAction?.fadeOut(0.2);
        newAction.reset().fadeIn(0.2).play();
      } else if (!newAction && oldAction) {
        oldAction.reset().fadeIn(0.2).play();
      }
      currentAction.current = newActionName;
    }

    // --- Third-Person Camera Position ---
    // Correctly get the player's current position from the physics body
    playerWorldPos.copy(rigidBodyRef.current.translation());

    // 1. Define the pivot point for the camera to orbit (player's torso)
    const pivotPoint = playerWorldPos.clone().add(new THREE.Vector3(0, 1.5, 0));

    // 2. Get the camera's direction from mouse controls
    camera.getWorldDirection(cameraDirection);

    // 3. Calculate the ideal camera position
    // Start at pivot, move back along the camera's direction vector
    desiredCameraPos.copy(pivotPoint).sub(cameraDirection.multiplyScalar(4.0));
    // 4. Add the "over the right shoulder" offset
    rightVector.setFromMatrixColumn(camera.matrix, 0); // Camera's local right vector
    desiredCameraPos.add(rightVector.multiplyScalar(1.2));
    
    // 5. Add a slight vertical offset
    desiredCameraPos.y += 0.5;

    // 6. Smoothly interpolate the camera's position for smooth following
    camera.position.lerp(desiredCameraPos, 10 * delta); // Using delta for frame-rate independence
  });

  return (
    <RigidBody ref={rigidBodyRef} colliders={false} mass={1} type="dynamic" position={[0, 1, 0]} enabledRotations={[false, true, false]}>
     <CapsuleCollider args={[0.6, 0.4]} />
      <group ref={group} dispose={null}>
        <primitive object={scene} scale={1.7} position={[0, -1.0, 0]} />
      </group>
    </RigidBody>
  );
}

// Preload the model for faster startup
useGLTF.preload(PLAYER_MODEL_URL);
useGLTF.preload(ASSAULT_RIFLE_MODEL_URL);
