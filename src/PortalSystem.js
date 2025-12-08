import * as THREE from 'three';

export class PortalSystem {
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.playerCamera = camera;
        this.renderer = renderer;
        
        this.portals = {
            blue: this.createPortalMesh(0x00aaff),
            orange: this.createPortalMesh(0xffaa00)
        };
        
        this.renderTargets = {
            blue: new THREE.WebGLRenderTarget(window.innerWidth / 2, window.innerHeight / 2),
            orange: new THREE.WebGLRenderTarget(window.innerWidth / 2, window.innerHeight / 2)
        };

        this.portalCam = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
        this.tempMatrix = new THREE.Matrix4();
        
        this.helperVec3 = new THREE.Vector3();
        this.helperBox3 = new THREE.Box3();
    }

    createPortalMesh(color) {
        // Portal is a simple plane for now
        const geometry = new THREE.PlaneGeometry(2, 3.5);
        const material = new THREE.MeshBasicMaterial({ color: color });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.userData.isPortal = true;
        mesh.userData.active = false;
        
        // Add a border
        const borderGeo = new THREE.RingGeometry(1, 1.1, 32); // Slightly flawed logic for a rectangular portal, let's use EdgesGeometry
        const edges = new THREE.EdgesGeometry(geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: color, linewidth: 4 }));
        mesh.add(line);
        
        this.scene.add(mesh);
        return mesh;
    }

    placePortal(type, point, normal) {
        const portal = this.portals[type];
        
        // Offset slightly from wall to prevent z-fighting
        const pos = point.clone().add(normal.clone().multiplyScalar(0.02));
        
        portal.position.copy(pos);
        
        // Orient portal to face away from wall
        portal.lookAt(pos.clone().add(normal));
        
        portal.visible = true;
        portal.userData.active = true;
        portal.userData.normal = normal;
        
        // If both portals are active, switch materials to render targets
        if (this.portals.blue.userData.active && this.portals.orange.userData.active) {
            this.portals.blue.material = new THREE.MeshBasicMaterial({ map: this.renderTargets.blue.texture });
            this.portals.orange.material = new THREE.MeshBasicMaterial({ map: this.renderTargets.orange.texture });
        }
    }

    render() {
        if (!this.portals.blue.userData.active || !this.portals.orange.userData.active) return;

        // Save current renderer state
        const currentRenderTarget = this.renderer.getRenderTarget();
        const currentXrEnabled = this.renderer.xr.enabled;
        this.renderer.xr.enabled = false;

        this.renderPortalView('blue', 'orange');
        this.renderPortalView('orange', 'blue');

        // Restore state
        this.renderer.setRenderTarget(currentRenderTarget);
        this.renderer.xr.enabled = currentXrEnabled;
    }

    renderPortalView(sourceName, destName) {
        const sourcePortal = this.portals[sourceName];
        const destPortal = this.portals[destName];
        const renderTarget = this.renderTargets[sourceName];

        // Calculate virtual camera position
        // 1. Get player relative to Source Portal
        const playerWorldPos = this.playerCamera.position;
        const sourceInverse = sourcePortal.matrixWorld.clone().invert();
        const playerLocal = playerWorldPos.clone().applyMatrix4(sourceInverse);
        
        // 2. Rotate 180 degrees around Y in local space (since portals exit opposite way)
        // Actually, for a simple implementation, we assume portals are "windows". 
        // Entering front of A comes out front of B.
        // We need to mirror the coordinate on the Z axis (local) and rotate 180 around Y.
        
        const rotationY180 = new THREE.Matrix4().makeRotationY(Math.PI);
        const destMatrix = destPortal.matrixWorld.clone().multiply(rotationY180);
        
        // Apply this transform to the camera
        this.portalCam.matrixAutoUpdate = false;
        
        // This is the transform from Source Local to Dest World
        // We take the player's position relative to Source, and apply it to Dest
        
        // Simplification for the test: 
        // Relative Matrix = SourceWorldInverse * CameraWorld
        // New Camera World = DestWorld * Rotation(PI) * RelativeMatrix
        
        const relativeMatrix = sourcePortal.matrixWorld.clone().invert().multiply(this.playerCamera.matrixWorld);
        const newMatrix = destPortal.matrixWorld.clone().multiply(rotationY180).multiply(relativeMatrix);
        
        this.portalCam.matrixWorld.copy(newMatrix);
        this.portalCam.matrixWorldInverse.copy(newMatrix).invert();
        
        // Update projection matrix to match player camera
        this.portalCam.projectionMatrix.copy(this.playerCamera.projectionMatrix);

        // Render
        // Hide destination portal in the view so we don't see the back of it blocking the view
        // (Though technically we might want to see through it if recursive, but preventing blocking is key)
        // A simple trick is setting near plane very close or using clipping planes.
        // For this demo, let's just render.
        
        // Important: We shouldn't see the portal surface we are looking "out" of in the render.
        // But since we are rendering from the perspective of the OTHER portal, that one is behind the camera.
        
        this.renderer.setRenderTarget(renderTarget);
        this.renderer.clear();
        this.renderer.render(this.scene, this.portalCam);
    }

    checkTeleport(playerCapsule, playerVelocity, playerCamera) {
        if (!this.portals.blue.userData.active || !this.portals.orange.userData.active) return false;

        const pairs = [
            { src: this.portals.blue, dest: this.portals.orange },
            { src: this.portals.orange, dest: this.portals.blue }
        ];

        for (const pair of pairs) {
            const { src, dest } = pair;
            
            // Check distance to portal center
            // Portal dimensions approx 2 wide, 3.5 tall
            const pPos = new THREE.Vector3();
            playerCapsule.getCenter(pPos);
            
            const dist = pPos.distanceTo(src.position);
            
            if (dist < 1.5) {
                // Check if we are crossing the plane
                // Dot product of vector (Portal -> Player) and Portal Normal
                // If it flips sign or is very small while moving INTO the portal...
                
                const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(src.quaternion);
                const vecToPlayer = pPos.clone().sub(src.position);
                const dot = vecToPlayer.dot(normal);
                
                // Are we moving into the portal?
                const velDot = playerVelocity.clone().normalize().dot(normal);

                // Simple check: if we are very close and moving roughly towards it (velDot < 0)
                if (Math.abs(dot) < 0.2 && velDot < 0) {
                    this.teleport(playerCapsule, playerVelocity, playerCamera, src, dest);
                    return true;
                }
            }
        }
        return false;
    }

    teleport(capsule, velocity, camera, src, dest) {
        // Play sound
        const audio = new Audio('teleport.mp3');
        audio.volume = 0.5;
        audio.play().catch(() => {});

        // 1. Position Transfer
        const currentPos = new THREE.Vector3();
        capsule.getCenter(currentPos);
        
        const srcInverse = src.matrixWorld.clone().invert();
        const localPos = currentPos.clone().applyMatrix4(srcInverse);
        
        // Flip Z because we enter front and exit front
        // And rotate 180 Y
        const rotationY180 = new THREE.Matrix4().makeRotationY(Math.PI);
        const destMatrix = dest.matrixWorld.clone().multiply(rotationY180);
        
        const newWorldPos = localPos.applyMatrix4(destMatrix);
        
        // Offset slightly out of the destination portal to prevent instant teleport back
        const destNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(dest.quaternion);
        newWorldPos.add(destNormal.multiplyScalar(0.5));
        
        capsule.translate(newWorldPos.sub(currentPos));

        // 2. Velocity Rotation
        // Transform direction vector
        const localVel = velocity.clone().applyQuaternion(src.quaternion.clone().invert());
        // Rotate 180 Y locally implies x -> -x, z -> -z
        localVel.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const newVel = localVel.applyQuaternion(dest.quaternion);
        velocity.copy(newVel);

        // 3. Camera Rotation
        // This is tricky because controls usually manage rotation via Euler angles (yaw/pitch).
        // We need to calculate the delta rotation between portals and apply it to the camera look.
        
        // Get relative quaternion
        const srcQ = src.quaternion.clone();
        const destQ = dest.quaternion.clone();
        
        // The rotation needed: Inverse(Src) -> Rotate 180 Y -> Dest
        const rot180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI);
        const deltaRot = destQ.multiply(rot180).multiply(srcQ.invert());
        
        // Apply to camera quaternion directly? 
        // Usually fps controls manage rotation via internal vars (pitch/yaw). 
        // We might need to expose a method in Player to "add rotation".
        // But for visual consistency we can try modifying the camera, 
        // though the next control update might snap it back if we don't update the controller state.
        
        // Return the rotation delta so the player controller can apply it to its state
        return deltaRot;
    }
}