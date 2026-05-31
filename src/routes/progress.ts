import { Router, Request, Response } from 'express';
import { ProgressModel } from '../models/Progress';
import logger from '../utils/logger';

const router = Router();

// Get student progress for a session
router.get('/student/:studentId/session/:sessionId', async (req: Request, res: Response) => {
  try {
    const { studentId, sessionId } = req.params;
    const progress = await ProgressModel.findByStudentAndSession(studentId, sessionId);
    const totalScore = await ProgressModel.getTotalScoreForSession(studentId, sessionId);

    res.json({
      success: true,
      data: {
        progress,
        totalScore,
      },
    });
  } catch (error) {
    logger.error('Error fetching progress:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch progress' });
  }
});

// Get all students' progress for a session (teacher view)
router.get('/session/:sessionId/all', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    // This would need a query to get all students in session
    // For now, return empty array
    res.json({
      success: true,
      data: [],
    });
  } catch (error) {
    logger.error('Error fetching all progress:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch progress' });
  }
});

export default router;
