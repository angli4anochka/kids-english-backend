import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { Pool } from 'pg';

// Initialize PostgreSQL pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'kids_english',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

interface SessionData {
  id: string;
  lesson_id: string;
  group_id: number;
  current_activity_index: number;
  is_active: boolean;
  is_interactive_enabled: boolean;
}

export function setupWebSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[WebSocket] Client connected: ${socket.id}`);

    let currentSessionId: string | null = null;
    let currentRoomId: string | null = null;
    let currentGroupRoomId: string | null = null;

    // ========== NEW: Session Management ==========

    // Join session (for both teacher and student)
    socket.on('join-session', async (data: any, callback: Function) => {
      try {
        const { lessonId, groupId, role, displayName, userId } = data;
        const roomId = `lesson-${lessonId}-group-${groupId}`;

        console.log(`[Session] ${role} ${displayName} joining lesson ${lessonId}, group ${groupId}`);

        // Join WebSocket room
        socket.join(roomId);
        currentSessionId = lessonId;
        currentRoomId = roomId;

        // Get or create session in DB
        let session: SessionData;

        if (role === 'teacher') {
          // Teacher creates/activates session
          const existing = await pool.query(
            'SELECT * FROM lesson_sessions WHERE lesson_id = $1 AND group_id = $2 AND is_active = true',
            [lessonId, groupId]
          );

          if (existing.rows.length > 0) {
            // Reactivate existing session
            session = existing.rows[0];
            await pool.query(
              'UPDATE lesson_sessions SET is_active = true, updated_at = NOW() WHERE id = $1',
              [session.id]
            );
          } else {
            // Create new session
            const result = await pool.query(
              `INSERT INTO lesson_sessions (lesson_id, group_id, teacher_id, current_activity_index, is_active)
               VALUES ($1, $2, $3, 0, true)
               RETURNING *`,
              [lessonId, groupId, userId || null]
            );
            session = result.rows[0];
          }

          // Add teacher as participant
          await pool.query(
            `INSERT INTO session_participants (session_id, user_id, display_name, role, is_online)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT DO NOTHING`,
            [session.id, userId, displayName, role]
          );

        } else {
          // Student joins existing session
          const result = await pool.query(
            'SELECT * FROM lesson_sessions WHERE lesson_id = $1 AND group_id = $2 AND is_active = true',
            [lessonId, groupId]
          );

          if (result.rows.length === 0) {
            callback({
              success: false,
              error: 'No active session found. Please wait for teacher to start the lesson.'
            });
            return;
          }

          session = result.rows[0];

          // Add student as participant
          await pool.query(
            `INSERT INTO session_participants (session_id, user_id, display_name, role, is_online)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT DO NOTHING`,
            [session.id, userId, displayName, role]
          );

          // Update last_seen_at
          await pool.query(
            'UPDATE session_participants SET is_online = true, last_seen_at = NOW() WHERE session_id = $1 AND display_name = $2',
            [session.id, displayName]
          );
        }

        // Get all online participants
        const participantsResult = await pool.query(
          'SELECT display_name, role, is_online FROM session_participants WHERE session_id = $1 AND is_online = true',
          [session.id]
        );

        const students = participantsResult.rows.filter(p => p.role === 'student');

        // Send response
        callback({
          success: true,
          session: {
            id: session.id,
            currentActivityIndex: session.current_activity_index,
            isInteractiveEnabled: session.is_interactive_enabled,
            students: students.map(s => ({
              displayName: s.display_name,
              isReady: true,
              avatarColor: '#3B82F6'
            }))
          }
        });

        // Notify others in room
        socket.to(roomId).emit('participant-joined', {
          displayName,
          role,
          totalStudents: students.length
        });

        console.log(`[Session] ${role} ${displayName} joined session ${session.id}`);

      } catch (error) {
        console.error('[Session] Error joining session:', error);
        callback({
          success: false,
          error: 'Failed to join session'
        });
      }
    });

    // Change activity (teacher only)
    socket.on('change-activity', async (data: any, callback: Function) => {
      try {
        const { activityIndex, lessonId, groupId } = data;

        console.log(`[Session] Teacher changing activity to index ${activityIndex}`);

        if (!currentSessionId) {
          callback({ success: false, error: 'Not in a session' });
          return;
        }

        // Update in database
        await pool.query(
          'UPDATE lesson_sessions SET current_activity_index = $1, updated_at = NOW() WHERE lesson_id = $2 AND group_id = $3 AND is_active = true',
          [activityIndex, lessonId || currentSessionId, groupId]
        );

        // Broadcast to all students in room
        if (currentRoomId) {
          socket.to(currentRoomId).emit('activity-changed', {
            activityIndex: activityIndex
          });
        }

        callback({ success: true });

        console.log(`[Session] Activity changed to ${activityIndex}, broadcasted to room`);

      } catch (error) {
        console.error('[Session] Error changing activity:', error);
        callback({ success: false, error: 'Failed to change activity' });
      }
    });

    // ========== Existing Events (kept for backward compatibility) ==========

    // Join group room (for receiving lesson notifications on island screen)
    socket.on('join-group-room', (data: { groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      socket.join(groupRoomId);
      currentGroupRoomId = groupRoomId;
      console.log(`[Lesson] User ${socket.id} joined group room: ${groupRoomId}`);
    });

    // Teacher navigates students to a lesson
    socket.on('navigate-to-lesson', (data: { lessonId: string; groupId: number; url: string }) => {
      const lessonRoomId = `lesson-${data.lessonId}-group-${data.groupId}`;
      const groupRoomId = `group-${data.groupId}`;
      console.log(`[Lesson] 🎯 Teacher navigating students in group ${data.groupId} to ${data.url}`);

      // Broadcast to all students in this group
      socket.to(groupRoomId).emit('navigate-to-lesson', { url: data.url });
      socket.to(lessonRoomId).emit('navigate-to-lesson', { url: data.url });
    });

    // New event handlers for live session synchronization
    socket.on('session:activity-change', (data: { sessionId: string; groupId: number; activityIndex: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      const roomSockets = (socket as any).adapter?.rooms?.get(groupRoomId);
      const roomSize = roomSockets ? roomSockets.size : 0;
      console.log(`[LiveSession] activity-change → session=${data.sessionId} groupId=${data.groupId} room=${groupRoomId} clients=${roomSize} idx=${data.activityIndex}`);

      socket.to(groupRoomId).emit('session:activity-changed', {
        sessionId: data.sessionId,
        activityIndex: data.activityIndex
      });
    });

    socket.on('session:interactive-toggle', (data: { sessionId: string; groupId: number; isInteractive: boolean }) => {
      const groupRoomId = `group-${data.groupId}`;
      console.log(`[LiveSession] Teacher toggled interactive to ${data.isInteractive} for session ${data.sessionId}`);
      
      // Broadcast to all students in this group
      socket.to(groupRoomId).emit('session:interactive-toggle', {
        sessionId: data.sessionId,
        isInteractive: data.isInteractive
      });
    });

    socket.on('session:ended', (data: { sessionId: string; groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      console.log(`[LiveSession] Teacher ended session ${data.sessionId}`);
      
      // Broadcast to all students in this group
      socket.to(groupRoomId).emit('session:ended', {
        sessionId: data.sessionId
      });
    });

    socket.on('leave-group-room', (data: { groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      socket.leave(groupRoomId);
      if (currentGroupRoomId === groupRoomId) currentGroupRoomId = null;
      console.log(`[Lesson] User ${socket.id} left group room: ${groupRoomId}`);
    });


    // ========== Screen Sharing WebRTC Signaling ==========

    socket.on('screen-share-ready', (data: { lessonId: string; groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      console.log(`[WebRTC] Teacher ready to share screen -> ${groupRoomId}`);
      // Include teacherId so students know where to send their ICE candidates
      socket.to(groupRoomId).emit('screen-share-ready', { ...data, teacherId: socket.id });
    });

    // Student asks teacher whether screen share is active (for late joiners)
    socket.on('screen-share-request', (data: { groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      console.log(`[WebRTC] Screen share request from ${socket.id} -> ${groupRoomId}`);
      socket.to(groupRoomId).emit('screen-share-request', { studentId: socket.id });
    });

    // Teacher replies to a specific student that screen share is active
    socket.on('screen-share-ready-to', (data: { studentId: string; lessonId: string; groupId: number }) => {
      console.log(`[WebRTC] Ready reply -> student ${data.studentId}`);
      if (data.studentId) {
        socket.to(data.studentId).emit('screen-share-ready', { lessonId: data.lessonId, groupId: data.groupId, teacherId: socket.id });
      }
    });

    socket.on('screen-share-offer', (data: { studentId: string; offer: any }) => {
      const room = currentGroupRoomId;
      console.log(`[WebRTC] Offer from student ${data.studentId} -> ${room}`);
      if (room) socket.to(room).emit('screen-share-offer', data);
    });

    socket.on('screen-share-answer', (data: { studentId: string; answer: any }) => {
      console.log(`[WebRTC] Answer -> student ${data.studentId}`);
      if (data.studentId) socket.to(data.studentId).emit('screen-share-answer', data);
    });

    socket.on('screen-share-ice-candidate', (data: { peerId: string; candidate: any }) => {
      if (data.peerId) {
        socket.to(data.peerId).emit('screen-share-ice-candidate', {
          peerId: socket.id,
          candidate: data.candidate,
        });
      }
    });

    socket.on('screen-share-stop', (data: { lessonId: string; groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      console.log(`[WebRTC] Teacher stopped screen sharing -> ${groupRoomId}`);
      socket.to(groupRoomId).emit('screen-share-stop', data);
    });


    // ========== Video/Audio Control Events ==========

    socket.on('video-control', (data: any) => {
      const room = data?.groupId != null ? `group-${data.groupId}` : (currentGroupRoomId || currentRoomId);
      if (room) {
        console.log(`[Video] Teacher ${data.action} video at ${data.currentTime}s -> ${room}`);
        socket.to(room).emit('video-control', data);
      } else {
        console.warn('[Video] No room to relay video-control');
      }
    });

    // YouTube sync: teacher broadcasts player state changes to the group
    socket.on('video-state-change', (data: any) => {
      const room = data?.groupId != null ? `group-${data.groupId}` : (currentGroupRoomId || currentRoomId);
      if (room) {
        console.log(`[Video] Teacher state=${data.state} at ${data.currentTime}s -> ${room}`);
        socket.to(room).emit('video-state-change', data);
      } else {
        console.warn('[Video] No room to relay video-state-change');
      }
    });

    // A student joining mid-video asks the teacher for the current state
    socket.on('request-video-state', (data: any) => {
      const room = data?.groupId != null ? `group-${data.groupId}` : (currentGroupRoomId || currentRoomId);
      if (room) {
        console.log(`[Video] Student requested current state -> ${room}`);
        socket.to(room).emit('request-video-state', data);
      } else {
        console.warn('[Video] No room to relay request-video-state');
      }
    });

    socket.on('audio-control', (data: any) => {
      const room = data?.groupId != null ? `group-${data.groupId}` : (currentGroupRoomId || currentRoomId);
      if (room) {
        console.log(`[Audio] Teacher ${data.action} audio -> ${room}`);
        socket.to(room).emit('audio-control', data);
      } else {
        console.warn('[Audio] No room to relay audio-control');
      }
    });

    // Student submits an activity result — relay to teacher(s) in the same group room
    socket.on('activity-result', (data: any) => {
      const room = data?.groupId != null ? `group-${data.groupId}` : (currentGroupRoomId || currentRoomId);
      if (room) {
        console.log(`[Result] Student ${data.studentName || data.studentId} finished activity ${data.activityId} score=${data.score} -> ${room}`);
        socket.to(room).emit('activity-result', data);
      } else {
        console.warn('[Result] No room to relay activity-result');
      }
    });

    // Student notifies teacher when their video is loaded (for live sessions)
    socket.on('video-ready', (data: any) => {
      const room = data?.groupId != null ? `group-${data.groupId}` : (currentGroupRoomId || currentRoomId);
      if (room) {
        socket.to(room).emit('video-ready', data);
      }
    });

    // ========== Disconnect Handler ==========

    socket.on('disconnect', async () => {
      console.log(`[WebSocket] Client disconnected: ${socket.id}`);

      if (currentSessionId && currentRoomId) {
        try {
          // Mark participant as offline
          await pool.query(
            `UPDATE session_participants
             SET is_online = false, last_seen_at = NOW()
             WHERE session_id IN (
               SELECT id FROM lesson_sessions WHERE lesson_id = $1 AND is_active = true
             )`,
            [currentSessionId]
          );

          // TODO: Implement graceful shutdown - if teacher disconnects, wait 30 seconds
          // then mark session as inactive if they don't reconnect

        } catch (error) {
          console.error('[Session] Error handling disconnect:', error);
        }
      }
    });
  });

  console.log('✅ WebSocket server initialized with session support');

  return io;
}
