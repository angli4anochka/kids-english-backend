export type UserRole = 'teacher' | 'student';

export type LessonMode = 'synchronized' | 'guided' | 'independent';

export type ActivityStatus = 'pending' | 'active' | 'completed';

export interface User {
  id: string;
  sessionCode?: string;
  role: UserRole;
  displayName: string;
  avatarColor: string;
  currentSessionId?: string;
  createdAt: Date;
}

export interface Session {
  id: string;
  teacherId: string;
  islandId: number;
  currentActivity: string | null;
  mode: LessonMode;
  status: 'active' | 'paused' | 'completed';
  expiresAt: Date;
  settings: {
    allowSelfPacing: boolean;
    autoAdvance: boolean;
  };
  createdAt: Date;
}

export interface StudentState {
  studentId: string;
  displayName: string;
  avatarColor: string;
  currentActivity: string | null;
  joinedAt: Date;
  totalPoints: number;
  activityProgress: {
    [activityId: string]: {
      status: ActivityStatus;
      earnedPoints: number;
      completedAt?: Date;
    };
  };
}

export interface LessonSession {
  sessionId: string;
  session: Session;
  students: Map<string, StudentState>;
}

export interface StudentProgress {
  id: string;
  studentId: string;
  sessionId: string;
  activityId: string;
  score: number;
  data: any;
  completedAt?: Date;
  createdAt: Date;
}

// WebSocket events
export interface ServerToClientEvents {
  'activity:changed': (data: { activityId: string; changedBy: string }) => void;
  'student:joined': (student: StudentState) => void;
  'student:left': (data: { studentId: string; displayName: string }) => void;
  'student:progress': (data: { studentId: string; activityId: string; points: number }) => void;
  'session:paused': (data: { pausedBy: string }) => void;
  'session:resumed': (data: { resumedBy: string }) => void;
  'session:completed': () => void;
  'error': (data: { message: string }) => void;
  // Screen sharing WebRTC
  'screen-share-ready': (data: { lessonId: string; groupId: number }) => void;
  'screen-share-offer': (data: { studentId: string; offer: any }) => void;
  'screen-share-answer': (data: { studentId: string; answer: any }) => void;
  'screen-share-ice-candidate': (data: { peerId: string; candidate: any }) => void;
  'screen-share-stop': (data: { lessonId: string; groupId: number }) => void;
  // Video control
  'video-control': (data: { lessonId: string; groupId: number; activityId: string; action: string; currentTime: number }) => void;
  'video-ready': (data: { lessonId: string; groupId: number; activityId: string; studentId: string; studentName: string }) => void;
  'audio-control': (data: { lessonId: string; groupId: number; activityId: string; action: string }) => void;
  // Lesson management
  'navigate-to-lesson': (data: { url: string }) => void;
  'activity-change': (data: { lessonId: string; newIndex: number }) => void;
  'interactive-toggle': (data: { lessonId: string; isEnabled: boolean }) => void;
  'student-progress-update': (data: { studentId: string; activityIndex: number; score: number; completed: boolean }) => void;
}

export interface ClientToServerEvents {
  'join:session': (data: { sessionCode: string; displayName: string; role: UserRole }, callback: (response: any) => void) => void;
  'teacher:changeActivity': (data: { activityId: string }, callback: (response: any) => void) => void;
  'student:updateProgress': (data: { activityId: string; score: number; data: any }, callback: (response: any) => void) => void;
  'session:pause': (callback: (response: any) => void) => void;
  'session:resume': (callback: (response: any) => void) => void;
  'session:complete': (callback: (response: any) => void) => void;
  // Screen sharing WebRTC
  'screen-share-ready': (data: { lessonId: string; groupId: number }) => void;
  'screen-share-offer': (data: { studentId: string; offer: any }) => void;
  'screen-share-answer': (data: { studentId: string; answer: any }) => void;
  'screen-share-ice-candidate': (data: { peerId: string; candidate: any }) => void;
  'screen-share-stop': (data: { lessonId: string; groupId: number }) => void;
  // Video control
  'video-control': (data: { lessonId: string; groupId: number; activityId: string; action: string; currentTime: number }) => void;
  'video-ready': (data: { lessonId: string; groupId: number; activityId: string }) => void;
  'audio-control': (data: { lessonId: string; groupId: number; activityId: string; action: string }) => void;
  // Lesson management
  'join-group-room': (data: { groupId: number }) => void;
  'check-active-lesson': (data: { groupId: number }) => void;
  'join-lesson-session': (data: { lessonId: string; groupId: number; role: string }) => void;
  'leave-lesson-session': (data: { lessonId: string; groupId: number }) => void;
  'navigate-to-lesson': (data: { lessonId: string; groupId: number; url: string }) => void;
  'activity-change': (data: { lessonId: string; groupId: number; newIndex: number }) => void;
  'interactive-toggle': (data: { lessonId: string; groupId: number; isEnabled: boolean }) => void;
  'update-progress': (data: { activityIndex: number; score: number; completed: boolean }) => void;
}
