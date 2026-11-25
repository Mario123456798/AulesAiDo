import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

void setPersistence(auth, browserLocalPersistence).catch(() => {
  // Ignore if persistence is already configured or restricted by environment
});

const provider = new GoogleAuthProvider();
export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
for (const scope of SCOPES) {
  provider.addScope(scope);
}

let isSigningIn = false;
let cachedAccessToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: (user: User | null) => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess?.(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.(user);
      }
    } else {
      cachedAccessToken = null;
      onAuthFailure?.(null);
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('No se pudo obtener el token de acceso de Google Drive');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
};

export const ensureDriveAccessToken = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  if (cachedAccessToken && auth.currentUser) {
    return { user: auth.currentUser, accessToken: cachedAccessToken };
  }
  return googleSignIn();
};

export const getDriveAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const getFirebaseIdToken = async (): Promise<string | null> => {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
};

export const logoutGoogle = async (): Promise<void> => {
  await auth.signOut();
  cachedAccessToken = null;
};
