# Wits Nav

Welcome to the repository! Below is an overview of the project structure and the mandatory workflow guidelines for contributing.

---

## 📁 Repository Structure

*   **`frontend/`** – Contains all the user interface (UI) code
*   **`backend/`** – Contains the backend stuff. NOTE: No backend yet, but once started then create this folder and save all the backend files here. 

---

## ⚙️ Development Workflow & Git Rules

To maintain a clean and functional codebase, all contributors must strictly follow these steps before making any changes.

### 1. Update Your Local Environment
Before you start any new work, ensure you have the latest updates from the development branch:
```bash
git checkout dev
git pull origin dev
```

### 2. Create a New Branch
Never commit directly to `dev`. Create a new branch specifically for the task you want to do. Use the following naming convention:
`<category>/<scope>/<short-description>`

#### 🏷️ Branch Categories:
*   **`feature`** – For creating a new feature (e.g., `feature/frontend/login-page`)
*   **`refactor`** – For changing or improving an existing feature without changing its behavior
*   **`fix`** – For fixing bugs and resolving errors (e.g., `fix/backend/auth-token`)

#### 💡 Examples:
*   Refactoring the home tab quick actions: `refactor/frontend/home-tab-quickactions`
*   Adding a new feature to the backend: `feature/backend/payment-gateway`

```bash
git checkout -b <your-branch-name>
```

### 3. Make and Test Your Changes
*   Work on your task inside your newly created branch.
*   Save your progress regularly using commits.
*   **Crucial Step:** Thoroughly test your changes locally to ensure everything works perfectly and nothing is broken.

### 4. Merge and Clean Up
Once your code is fully tested and verified:
1.  Merge your changes into the `dev` branch (typically via a Pull/Merge Request on GitHub/GitLab).
2.  After the merge is successful, delete your local and remote feature branches to keep the repository clean.

```bash
# Delete locally
git branch -d <branch-name>

# Delete remotely
git push origin --delete <branch-name>
```
