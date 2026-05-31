import { Server, Socket } from 'socket.io';
import { ServerToClientEvents, ClientToServerEvents, StudentState } from '../types';
import { sessionManager } from './SessionManager';
import { SessionModel } from '../models/Session';
import { UserModel } from '../models/User';
import { ProgressModel } from '../models/Progress';
import { isValidSessionCode } from '../utils/sessionCode';
import logger from '../utils/logger';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export function setupSocketHandlers(io: Server) {
  io.on('connection', (socket: TypedSocket) => {
    logger.info(`Client connected: ${socket.id}`);

    let currentSessionId: string | null = null;
    let currentUserId: string | null = null;
    let currentUserRole: 'teacher' | 'student' | null = null;

    // Join session
    socket.on('join:session', async ({ sessionCode, displayName, role }, callback) => {
      try {
        // Validate session code
        if (!isValidSessionCode(sessionCode)) {
          callback({ success: false, error: 'Invalid session code format' });
          return;
        }

        // Find teacher by session code
        const teacher = await UserModel.findBySessionCode(sessionCode);
        if (!teacher || teacher.role !== 'teacher') {
          callback({ success: false, error: 'Session not found' });
          return;
        }

        // Get active session
        const sessions = await SessionModel.findActiveByTeacher(teacher.id);
        if (sessions.length === 0) {
          callback({ success: false, error: 'No active session found' });
          return;
        }

        const session = sessions[0];
        currentSessionId = session.id;

        // Create or get user
        const avatarColor = generateRandomColor();
        const user = await UserModel.create(displayName, role, avatarColor);
        await UserModel.updateCurrentSession(user.id, session.id);

        currentUserId = user.id;
        currentUserRole = role;

        // Join socket room
        socket.join(session.id);

        // Get lesson session
        const lessonSession = await sessionManager.getSession(session.id, session);

        if (role === 'student') {
          // Add student to session
          const studentState: StudentState = {
            studentId: user.id,
            displayName,
            avatarColor,
            currentActivity: session.currentActivity,
            joinedAt: new Date(),
            totalPoints: 0,
            activityProgress: {},
          };

          await sessionManager.addStudent(session.id, studentState);

          // Notify teacher and other students
          io.to(session.id).emit('student:joined', studentState);
        }

        // Send current state to joined user
        const students = sessionManager.getStudents(session.id);
        callback({
          success: true,
          data: {
            sessionId: session.id,
            userId: user.id,
            session,
            students,
            currentActivity: session.currentActivity,
          },
        });

        logger.info(`User ${displayName} (${role}) joined session ${session.id}`);
      } catch (error) {
        logger.error('Error joining session:', error);
        callback({ success: false, error: 'Failed to join session' });
      }
    });

    // Teacher changes activity
    socket.on('teacher:changeActivity', async ({ activityId }, callback) => {
      try {
        if (currentUserRole !== 'teacher' || !currentSessionId) {
          callback({ success: false, error: 'Unauthorized' });
          return;
        }

        // Update in database
        await SessionModel.updateActivity(currentSessionId, activityId);

        // Update in session manager
        const session = await SessionModel.findById(currentSessionId);
        if (session) {
          session.currentActivity = activityId;
        }

        // Broadcast to all students
        io.to(currentSessionId).emit('activity:changed', {
          activityId,
          changedBy: currentUserId!,
        });

        callback({ success: true });
        logger.info(`Activity changed to ${activityId} in session ${currentSessionId}`);
      } catch (error) {
        logger.error('Error changing activity:', error);
        callback({ success: false, error: 'Failed to change activity' });
      }
    });

    // Student updates progress
    socket.on('student:updateProgress', async ({ activityId, score, data }, callback) => {
      try {
        if (currentUserRole !== 'student' || !currentSessionId || !currentUserId) {
          callback({ success: false, error: 'Unauthorized' });
          return;
        }

        // Check if progress exists
        let progress = await ProgressModel.findByStudentActivitySession(
          currentUserId,
          currentSessionId,
          activityId
        );

        if (progress) {
          // Update existing
          progress = await ProgressModel.update(progress.id, score, data);
        } else {
          // Create new
          progress = await ProgressModel.create(currentUserId, currentSessionId, activityId, score, data);
        }

        // Update session manager
        await sessionManager.updateStudentProgress(currentSessionId, currentUserId, activityId, score);

        // Notify teacher
        io.to(currentSessionId).emit('student:progress', {
          studentId: currentUserId,
          activityId,
          points: score,
        });

        callback({ success: true, data: progress });
        logger.info(`Student ${currentUserId} updated progress: ${score} points`);
      } catch (error) {
        logger.error('Error updating progress:', error);
        callback({ success: false, error: 'Failed to update progress' });
      }
    });

    // ========== Screen Sharing WebRTC Events ==========

    // Teacher signals they're ready to broadcast screen
    socket.on('screen-share-ready', ({ lessonId, groupId }) => {
      logger.info(`[WebRTC] Teacher ready to share screen in session ${currentSessionId}`);
      if (currentSessionId) {
        // Broadcast to all students in the session
        socket.to(currentSessionId).emit('screen-share-ready', { lessonId, groupId });
      }
    });

    // Student sends offer to teacher
    socket.on('screen-share-offer', ({ studentId, offer }) => {
      logger.info(`[WebRTC] Received offer from student ${studentId}`);
      if (currentSessionId) {
        // Send offer to teacher (broadcast to room, teacher will handle it)
        socket.to(currentSessionId).emit('screen-share-offer', { studentId, offer });
      }
    });

    // Teacher sends answer to student
    socket.on('screen-share-answer', ({ studentId, answer }) => {
      logger.info(`[WebRTC] Sending answer to student ${studentId}`);
      if (currentSessionId) {
        // Send answer to specific student
        socket.to(currentSessionId).emit('screen-share-answer', { studentId, answer });
      }
    });

    // ICE candidate exchange
    socket.on('screen-share-ice-candidate', ({ peerId, candidate }) => {
      logger.info(`[WebRTC] Forwarding ICE candidate to ${peerId}`);
      if (currentSessionId) {
        // Forward ICE candidate to the peer
        socket.to(currentSessionId).emit('screen-share-ice-candidate', { peerId: socket.id, candidate });
      }
    });

    // Teacher stops screen sharing
    socket.on('screen-share-stop', ({ lessonId, groupId }) => {
      logger.info(`[WebRTC] Teacher stopped screen sharing`);
      if (currentSessionId) {
        // Notify all students
        socket.to(currentSessionId).emit('screen-share-stop', { lessonId, groupId });
      }
    });

    // ========== Video Control Events ==========

    // Teacher controls video playback
    socket.on('video-control', (data) => {
      logger.info(`[Video] Teacher ${data.action} video at ${data.currentTime}s`);
      if (currentSessionId) {
        // Broadcast to all students
        socket.to(currentSessionId).emit('video-control', data);
      }
    });

    // Student notifies video is ready
    socket.on('video-ready', (data) => {
      logger.info(`[Video] Student video ready for activity ${data.activityId}`);
      if (currentSessionId && currentUserId) {
        // Get student name
        const students = sessionManager.getStudents(currentSessionId);
        const student = students.find(s => s.studentId === currentUserId);

        // Notify teacher
        socket.to(currentSessionId).emit('video-ready', {
          ...data,
          studentId: currentUserId,
          studentName: student?.displayName || 'Unknown'
        });
      }
    });

    // Audio control for synced playback
    socket.on('audio-control', (data) => {
      logger.info(`[Audio] Teacher ${data.action} audio for activity ${data.activityId}`);
      if (currentSessionId) {
        // Broadcast to all students
        socket.to(currentSessionId).emit('audio-control', data);
      }
    });

    // ========== Lesson Management Events ==========

    // Join group room (for receiving lesson notifications on island screen)
    socket.on('join-group-room', (data: { groupId: number }) => {
      const groupRoomId = `group-${data.groupId}`;
      socket.join(groupRoomId);
      logger.info(`[Lesson] User joined group room: ${groupRoomId}`);
    });

    // Check for active lessons in a group
    socket.on('check-active-lesson', (data: { groupId: number }) => {
      logger.info(`[Lesson] Student checking for active lessons in group ${data.groupId}`);
      // This is handled by the frontend - backend just logs it
      // Teacher will send navigate-to-lesson which will reach students in group room
    });

    // Join lesson session
    socket.on('join-lesson-session', (data: { lessonId: string; groupId: number; role: string }) => {
      const lessonRoomId = `lesson-${data.lessonId}-group-${data.groupId}`;
      socket.join(lessonRoomId);
      logger.info(`[Lesson] ${data.role} joined lesson session: ${lessonRoomId}`);
    });

    // Leave lesson session
    socket.on('leave-lesson-session', (data: { lessonId: string; groupId: number }) => {
      const lessonRoomId = `lesson-${data.lessonId}-group-${data.groupId}`;
      socket.leave(lessonRoomId);
      logger.info(`[Lesson] User left lesson session: ${lessonRoomId}`);
    });

    // Teacher navigates students to a lesson
    socket.on('navigate-to-lesson', (data: { lessonId: string; groupId: number; url: string }) => {
      const lessonRoomId = `lesson-${data.lessonId}-group-${data.groupId}`;
      const groupRoomId = `group-${data.groupId}`;
      logger.info(`[Lesson] Teacher navigating students in group ${data.groupId} to ${data.url}`);

      // Broadcast to all students in this group (including those on island screen)
      socket.to(groupRoomId).emit('navigate-to-lesson', { url: data.url });

      // Also broadcast to lesson room in case some students already joined
      socket.to(lessonRoomId).emit('navigate-to-lesson', { url: data.url });
    });

    // Teacher changes activity
    socket.on('activity-change', (data: { lessonId: string; groupId: number; newIndex: number }) => {
      const lessonRoomId = `lesson-${data.lessonId}-group-${data.groupId}`;
      logger.info(`[Lesson] Teacher changed activity to index ${data.newIndex} in ${lessonRoomId}`);

      // Broadcast to all students in this lesson/group
      socket.to(lessonRoomId).emit('activity-change', {
        lessonId: data.lessonId,
        newIndex: data.newIndex,
      });
    });

    // Teacher toggles interactive mode
    socket.on('interactive-toggle', (data: { lessonId: string; groupId: number; isEnabled: boolean }) => {
      const lessonRoomId = `lesson-${data.lessonId}-group-${data.groupId}`;
      logger.info(`[Lesson] Teacher toggled interactive mode to ${data.isEnabled} in ${lessonRoomId}`);

      // Broadcast to all students in this lesson/group
      socket.to(lessonRoomId).emit('interactive-toggle', {
        lessonId: data.lessonId,
        isEnabled: data.isEnabled,
      });
    });

    // Student updates progress
    socket.on('update-progress', (data: { activityIndex: number; score: number; completed: boolean }) => {
      logger.info(`[Lesson] Student ${currentUserId} updated progress: activity ${data.activityIndex}, score ${data.score}`);

      // Optionally broadcast to teacher/other students if needed
      if (currentSessionId && currentUserId) {
        socket.to(currentSessionId).emit('student-progress-update', {
          studentId: currentUserId,
          activityIndex: data.activityIndex,
          score: data.score,
          completed: data.completed,
        });
      }
    });

    // Disconnect
    socket.on('disconnect', async () => {
      logger.info(`Client disconnected: ${socket.id}`);

      if (currentSessionId && currentUserId && currentUserRole === 'student') {
        const student = await sessionManager.removeStudent(currentSessionId, currentUserId);
        if (student) {
          io.to(currentSessionId).emit('student:left', {
            studentId: student.studentId,
            displayName: student.displayName,
          });
        }
      }
    });
  });

  // Cleanup task every hour
  setInterval(async () => {
    await sessionManager.cleanupExpiredSessions();
  }, 60 * 60 * 1000);
}

function generateRandomColor(): string {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE'];
  return colors[Math.floor(Math.random() * colors.length)];
}
