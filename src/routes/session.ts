import { Router, Request, Response } from 'express';
import { SessionModel } from '../models/Session';
import { UserModel } from '../models/User';
import { generateSessionCode } from '../utils/sessionCode';
import { sessionCreationLimiter } from '../middleware/rateLimiter';
import logger from '../utils/logger';

const router = Router();

// Create new session (teacher only)
router.post('/create', sessionCreationLimiter, async (req: Request, res: Response) => {
  try {
    const { teacherName, islandId, mode } = req.body;

    if (!teacherName || !islandId) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }

    // Create teacher user
    const avatarColor = '#4ECDC4';
    const teacher = await UserModel.create(teacherName, 'teacher', avatarColor);

    // Generate unique session code
    const sessionCode = generateSessionCode();
    await UserModel.updateSessionCode(teacher.id, sessionCode);

    // Create session
    const session = await SessionModel.create(teacher.id, islandId, mode || 'synchronized');
    await UserModel.updateCurrentSession(teacher.id, session.id);

    logger.info(`Session created: ${session.id} by ${teacherName} (code: ${sessionCode})`);

    res.json({
      success: true,
      data: {
        session,
        sessionCode,
        teacherId: teacher.id,
      },
    });
  } catch (error) {
    logger.error('Error creating session:', error);
    res.status(500).json({ success: false, error: 'Failed to create session' });
  }
});

// Get session details
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = await SessionModel.findById(sessionId);

    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Error fetching session:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch session' });
  }
});

// Update session activity (teacher only)
router.patch('/:sessionId/activity', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { activityId } = req.body;

    if (!activityId) {
      res.status(400).json({ success: false, error: 'Activity ID required' });
      return;
    }

    await SessionModel.updateActivity(sessionId, activityId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error updating activity:', error);
    res.status(500).json({ success: false, error: 'Failed to update activity' });
  }
});

// Complete session
router.post('/:sessionId/complete', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    await SessionModel.updateStatus(sessionId, 'completed');
    logger.info(`Session ${sessionId} completed`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error completing session:', error);
    res.status(500).json({ success: false, error: 'Failed to complete session' });
  }
});

export default router;
